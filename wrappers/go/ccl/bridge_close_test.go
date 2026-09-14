package ccl

import (
	"errors"
	"testing"
	"time"
)

// Before the guard this did not fail — it hung forever on a nil channel while holding the mutex,
// deadlocking every other goroutine too. A timeout makes that visible as a test failure.
func TestUseAfterCloseReturnsErrorNotDeadlock(t *testing.T) {
	b, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := b.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	done := make(chan error, 1)
	go func() { _, e := b.Version(); done <- e }()

	select {
	case e := <-done:
		if !errors.Is(e, ErrBridgeClosed) {
			t.Errorf("after Close, got %v; want ErrBridgeClosed", e)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("DEADLOCK: call after Close never returned")
	}

	// And the mutex must not be poisoned — a second call still returns promptly.
	go func() { _, e := b.Accounts.Create(Testnet); done <- e }()
	select {
	case e := <-done:
		if !errors.Is(e, ErrBridgeClosed) {
			t.Errorf("second call after Close: got %v; want ErrBridgeClosed", e)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("DEADLOCK: mutex still held by the first post-Close call")
	}
}
