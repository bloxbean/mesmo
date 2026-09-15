package mesmo

import (
	"bufio"
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"
)

// Yaci DevKit integration tests for QuickTx.
//
// Requires:
// - Yaci DevKit running on port 10000
// - Native library built: ./gradlew :core:nativeCompile
//
// Run with:
//   cd wrappers/go && go test -v -run Integration ./mesmo/

const devkitURL = "http://localhost:10000/local-cluster/api"
const devkitProviderURL = "http://localhost:10000/local-cluster/api"

// devkitHTTP bounds every helper call so a wedged devnet fails the call fast instead of hanging
// the test until its whole timeout budget is gone.
var devkitHTTP = &http.Client{Timeout: 30 * time.Second}

// devkitAvailable checks if Yaci DevKit is running.
func devkitAvailable() bool {
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(devkitURL + "/admin/devnet")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == 200
}

// devkitReset restarts the devnet and returns only once it serves chain data again.
//
// DevKit 0.12 (companion mode) re-bootstraps the whole cluster on reset, and that bootstrap can
// wedge (e.g. the relay never syncs from the companion within its window), leaving the node socket
// dead until the NEXT reset POST kicks the cluster back to life. So: POST the reset, poll until the
// chain-data API answers, and if the devnet stays dead re-POST the reset. On total failure it just
// returns — the caller's topup/build will then fail with its own error.
func devkitReset() {
	// The reset handler blocks while the cluster re-bootstraps (~20-30s when healthy).
	client := &http.Client{Timeout: 60 * time.Second}
	for attempt := 1; attempt <= 3; attempt++ {
		req, _ := http.NewRequest("POST", devkitURL+"/admin/devnet/reset", nil)
		// A client timeout here is fine: the bootstrap keeps running server-side and the
		// health poll below is what decides.
		if resp, err := client.Do(req); err == nil {
			resp.Body.Close()
		}
		if devkitWaitHealthy(60 * time.Second) {
			return
		}
		fmt.Printf("devkit reset attempt %d/3: devnet still down, re-posting reset\n", attempt)
	}
	fmt.Println("devkit reset: devnet did not serve chain data after 3 attempts")
}

// devkitWaitHealthy polls until the chain-data API (yaci-store, fed by the node) answers with
// protocol parameters AND the submit path reaches the backend submit-api. /admin/devnet alone is
// no proof: it stays 200 while the node socket is dead. The submit probe matters because a reset's
// bootstrap can fail to start the submit-api entirely ("Network.Socket.bind: resource busy" — the
// previous instance hadn't released port 8090); chain data then works but every submit gets
// "Connection refused" until the next reset. Probing with a garbage body: any deserialization /
// ledger 400 proves the submit-api is alive; a body wrapping "Connection refused" does not.
func devkitWaitHealthy(budget time.Duration) bool {
	deadline := time.Now().Add(budget)
	client := &http.Client{Timeout: 5 * time.Second}
	for time.Now().Before(deadline) {
		time.Sleep(3 * time.Second)
		resp, err := client.Get(devkitURL + "/epochs/parameters")
		if err != nil {
			continue
		}
		ok := resp.StatusCode == 200
		resp.Body.Close()
		if !ok {
			continue
		}
		if devkitSubmitPathAlive(client) {
			return true
		}
	}
	return false
}

func devkitSubmitPathAlive(client *http.Client) bool {
	resp, err := client.Post(devkitURL+"/tx/submit", "application/cbor", bytes.NewReader([]byte{0x00}))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return !strings.Contains(string(body), "Connection refused")
}

func devkitTopup(address string, adaAmount int) error {
	body, _ := json.Marshal(map[string]interface{}{
		"address":   address,
		"adaAmount": adaAmount,
	})
	// devkitReset already health-gates the devnet, but the faucet can still transiently refuse
	// right after the hand-over to the node ("Topup failed"). Retry with backoff.
	var lastErr error
	for attempt := 1; attempt <= 8; attempt++ {
		resp, err := devkitHTTP.Post(devkitURL+"/addresses/topup", "application/json", bytes.NewReader(body))
		if err != nil {
			lastErr = err
		} else {
			b, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode == 200 && !strings.Contains(string(b), "\"status\":false") {
				return nil
			}
			lastErr = fmt.Errorf("topup failed (%d): %s", resp.StatusCode, string(b))
		}
		time.Sleep(4 * time.Second)
	}
	return lastErr
}

func devkitGetUtxos(address string) ([]map[string]interface{}, error) {
	resp, err := devkitHTTP.Get(devkitURL + "/addresses/" + address + "/utxos")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var utxos []map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&utxos); err != nil {
		return nil, err
	}
	return utxos, nil
}

func devkitGetProtocolParams() (map[string]interface{}, error) {
	resp, err := devkitHTTP.Get(devkitURL + "/epochs/parameters")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var pp map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&pp); err != nil {
		return nil, err
	}
	return pp, nil
}

// parseExpectedTreasury pulls the expected treasury value out of a Conway
// ConwayTreasuryValueMismatch rejection, e.g. "... expected: Coin 43186776312112}".
func parseExpectedTreasury(submitErr string) string {
	m := regexp.MustCompile(`expected:\s*Coin\s*(\d+)`).FindStringSubmatch(submitErr)
	if len(m) == 2 {
		return m[1]
	}
	return ""
}

// devkitSubmitTx submits with a retry: after a reset, the devkit's backend submit-api (port 8090)
// can lag behind the chain-data API that devkitReset health-gates on — the devkit then returns 400
// wrapping "Connection refused". That's the devnet still booting, not a ledger rejection, so retry
// it; genuine rejections surface immediately.
func devkitSubmitTx(txCborHex string) (string, error) {
	var lastErr error
	for attempt := 1; attempt <= 8; attempt++ {
		hash, err := devkitSubmitTxOnce(txCborHex)
		if err == nil || !strings.Contains(err.Error(), "Connection refused") {
			return hash, err
		}
		lastErr = err
		time.Sleep(4 * time.Second)
	}
	return "", lastErr
}

func devkitSubmitTxOnce(txCborHex string) (string, error) {
	// Use raw TCP to avoid Go's strict "duplicate chunked TE" rejection
	txBytes, err := hex.DecodeString(txCborHex)
	if err != nil {
		return "", fmt.Errorf("invalid tx hex: %w", err)
	}

	conn, err := net.DialTimeout("tcp", "localhost:10000", 10*time.Second)
	if err != nil {
		return "", fmt.Errorf("connect: %w", err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(30 * time.Second))

	// Write raw HTTP request
	var reqBuf bytes.Buffer
	fmt.Fprintf(&reqBuf, "POST /local-cluster/api/tx/submit HTTP/1.1\r\n")
	fmt.Fprintf(&reqBuf, "Host: localhost:10000\r\n")
	fmt.Fprintf(&reqBuf, "Content-Type: application/cbor\r\n")
	fmt.Fprintf(&reqBuf, "Content-Length: %d\r\n", len(txBytes))
	fmt.Fprintf(&reqBuf, "Connection: close\r\n")
	fmt.Fprintf(&reqBuf, "\r\n")
	reqBuf.Write(txBytes)

	if _, err := conn.Write(reqBuf.Bytes()); err != nil {
		return "", fmt.Errorf("write: %w", err)
	}

	// Read response
	reader := bufio.NewReader(conn)
	// Read status line
	statusLine, err := reader.ReadString('\n')
	if err != nil {
		return "", fmt.Errorf("read status: %w", err)
	}
	parts := strings.SplitN(strings.TrimSpace(statusLine), " ", 3)
	if len(parts) < 2 {
		return "", fmt.Errorf("malformed status: %s", statusLine)
	}

	// Read headers until empty line
	var contentLength int
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return "", fmt.Errorf("read header: %w", err)
		}
		line = strings.TrimSpace(line)
		if line == "" {
			break
		}
		if strings.HasPrefix(strings.ToLower(line), "content-length:") {
			fmt.Sscanf(strings.TrimSpace(line[15:]), "%d", &contentLength)
		}
	}

	// Read body
	var body []byte
	if contentLength > 0 {
		body = make([]byte, contentLength)
		_, err = io.ReadFull(reader, body)
	} else {
		body, err = io.ReadAll(reader)
	}
	if err != nil && err != io.EOF {
		return "", fmt.Errorf("read body: %w", err)
	}

	statusCode := parts[1]
	if statusCode != "200" && statusCode != "202" {
		return "", fmt.Errorf("submit failed (%s): %s", statusCode, string(body))
	}

	txHash := strings.TrimSpace(string(body))
	txHash = strings.Trim(txHash, "\"")
	return txHash, nil
}

func devkitGetTx(txHash string) (map[string]interface{}, error) {
	resp, err := devkitHTTP.Get(devkitURL + "/txs/" + txHash)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("get tx failed (%d)", resp.StatusCode)
	}
	var tx map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&tx); err != nil {
		return nil, err
	}
	return tx, nil
}

func waitForBlock() {
	time.Sleep(3 * time.Second)
}

func skipIfNoDevKit(t *testing.T) {
	t.Helper()
	if !devkitAvailable() {
		t.Skip("Yaci DevKit not available on port 10000")
	}
}

func fundSender(t *testing.T, ada int) testAccount {
	t.Helper()
	account := createTestAccount(t, Testnet)
	if err := devkitTopup(account.BaseAddress, ada); err != nil {
		t.Fatalf("topup: %v", err)
	}
	waitForBlock()
	return account
}

func totalLovelace(utxos []map[string]interface{}) int64 {
	var total int64
	for _, u := range utxos {
		amounts, ok := u["amount"].([]interface{})
		if !ok {
			continue
		}
		for _, a := range amounts {
			am, ok := a.(map[string]interface{})
			if !ok {
				continue
			}
			if am["unit"] == "lovelace" {
				switch q := am["quantity"].(type) {
				case float64:
					total += int64(q)
				case string:
					var v int64
					fmt.Sscanf(q, "%d", &v)
					total += v
				}
			}
		}
	}
	return total
}

// --- Integration Tests ---

func TestIntegrationSimpleADATransfer(t *testing.T) {
	skipIfNoDevKit(t)
	devkitReset()
	waitForBlock()

	sender := fundSender(t, 150)
	receiver := createTestAccount(t, Testnet)

	utxos, err := devkitGetUtxos(sender.BaseAddress)
	if err != nil {
		t.Fatalf("get utxos: %v", err)
	}
	pp, err := devkitGetProtocolParams()
	if err != nil {
		t.Fatalf("get pp: %v", err)
	}

	yaml := quickTxYaml(sender.BaseAddress, receiver.BaseAddress, "5000000")
	result, err := lib.QuickTx.Build(yaml, utxos, pp, 0)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	assertTxResult(t, result)

	signedTx := signWithMnemonic(t, sender.Mnemonic, result.TxCbor)
	txHash, err := devkitSubmitTx(signedTx)
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	if txHash == "" {
		t.Fatal("empty tx hash from submit")
	}

	waitForBlock()
	receiverUtxos, err := devkitGetUtxos(receiver.BaseAddress)
	if err != nil {
		t.Fatalf("get receiver utxos: %v", err)
	}
	if total := totalLovelace(receiverUtxos); total != 5_000_000 {
		t.Errorf("expected 5 ADA (5000000), got %d lovelace", total)
	}
}

func TestIntegrationMultipleReceivers(t *testing.T) {
	skipIfNoDevKit(t)
	devkitReset()
	waitForBlock()

	sender := fundSender(t, 150)
	r1 := createTestAccount(t, Testnet)
	r2 := createTestAccount(t, Testnet)

	utxos, err := devkitGetUtxos(sender.BaseAddress)
	if err != nil {
		t.Fatalf("get utxos: %v", err)
	}
	pp, err := devkitGetProtocolParams()
	if err != nil {
		t.Fatalf("get pp: %v", err)
	}

	yaml := fmt.Sprintf(`
version: 1.0
transaction:
  - tx:
      from: %s
      intents:
        - type: payment
          address: %s
          amounts:
            - unit: lovelace
              quantity: "3000000"
        - type: payment
          address: %s
          amounts:
            - unit: lovelace
              quantity: "2000000"
`, sender.BaseAddress, r1.BaseAddress, r2.BaseAddress)

	result, err := lib.QuickTx.Build(yaml, utxos, pp, 0)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	signedTx := signWithMnemonic(t, sender.Mnemonic, result.TxCbor)
	if _, err := devkitSubmitTx(signedTx); err != nil {
		t.Fatalf("submit: %v", err)
	}

	waitForBlock()
	if total := totalLovelace(mustUtxos(t, r1.BaseAddress)); total != 3_000_000 {
		t.Errorf("expected 3 ADA for r1, got %d", total)
	}
	if total := totalLovelace(mustUtxos(t, r2.BaseAddress)); total != 2_000_000 {
		t.Errorf("expected 2 ADA for r2, got %d", total)
	}
}

func TestIntegrationInsufficientFunds(t *testing.T) {
	skipIfNoDevKit(t)
	devkitReset()
	waitForBlock()

	sender := fundSender(t, 2)
	receiver := createTestAccount(t, Testnet)

	utxos, _ := devkitGetUtxos(sender.BaseAddress)
	pp, _ := devkitGetProtocolParams()

	yaml := quickTxYaml(sender.BaseAddress, receiver.BaseAddress, "100000000")
	if _, err := lib.QuickTx.Build(yaml, utxos, pp, 0); err == nil {
		t.Fatal("expected insufficient funds error")
	}
}

func mustUtxos(t *testing.T, address string) []map[string]interface{} {
	t.Helper()
	utxos, err := devkitGetUtxos(address)
	if err != nil {
		t.Fatalf("get utxos: %v", err)
	}
	return utxos
}

// The shipped YaciProvider fetches the devnet's real chain data and feeds Build via BuildWith.
func TestIntegrationBuildWith(t *testing.T) {
	skipIfNoDevKit(t)
	devkitReset()
	waitForBlock()

	sender := fundSender(t, 150)
	receiver := createTestAccount(t, Testnet)

	provider := NewYaciProvider("") // local DevKit cluster
	yaml := quickTxYaml(sender.BaseAddress, receiver.BaseAddress, "5000000")
	result, err := lib.QuickTx.BuildWith(yaml, provider, []string{sender.BaseAddress}, 0)
	if err != nil {
		t.Fatalf("BuildWith: %v", err)
	}
	assertTxResult(t, result)
}

// signWithMnemonic signs with the payment role through a managed handle opened for the call.
func signWithMnemonic(t *testing.T, mnemonic, txCbor string) string {
	t.Helper()
	acct, err := lib.Accounts.FromMnemonic(mnemonic, Testnet, 0, 0)
	if err != nil {
		t.Fatalf("Accounts.FromMnemonic: %v", err)
	}
	defer acct.Close()
	signed, err := acct.SignTx(txCbor, RolePayment)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return signed
}
