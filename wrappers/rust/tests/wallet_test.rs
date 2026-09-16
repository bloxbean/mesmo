//! The HD-wallet use case on the managed-accounts API: a wallet is one recovery phrase, and each
//! address is one CIP-1852 payment leaf — one handle per leaf. The mainnet create / restore /
//! enumeration paths live in integration_test.rs; this adds the testnet stake-address prefix case.

use mesmo::Mesmo;

fn lib() -> Mesmo {
    Mesmo::new().expect("Failed to create lib")
}

#[test]
fn test_wallet_create_testnet() {
    let b = lib();
    let acct = b
        .accounts()
        .create(mesmo::Network::Testnet)
        .expect("Failed to create account");
    let info = acct.info().expect("Failed to get info");
    assert!(info["stake_address"]
        .as_str()
        .unwrap()
        .starts_with("stake_test1"));
}
