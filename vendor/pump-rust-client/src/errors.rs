//! Error type for the offline `PumpSdk` and the async `AsyncPumpClient`.

use solana_program::pubkey::Pubkey;

#[derive(Debug)]
pub enum PumpClientError {
    /// `try_deserialize` rejected the buffer (wrong discriminator, truncated, etc).
    Decode(Box<anchor_lang::error::Error>),
    /// RPC layer returned an error (network, RPC, deserialization at the JSON-RPC level).
    /// Boxed because `ClientError` is ~256 bytes — keeps `Result<T, _>` small.
    #[cfg(feature = "client")]
    Rpc(Box<solana_client::client_error::ClientError>),
    /// Required account did not exist on chain.
    AccountNotFound { name: &'static str, address: Pubkey },
}

impl std::fmt::Display for PumpClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Decode(e) => write!(f, "anchor decode error: {e}"),
            #[cfg(feature = "client")]
            Self::Rpc(e) => write!(f, "rpc error: {e}"),
            Self::AccountNotFound { name, address } => {
                write!(f, "account not found ({name}): {address}")
            }
        }
    }
}

impl std::error::Error for PumpClientError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Decode(e) => Some(&**e),
            #[cfg(feature = "client")]
            Self::Rpc(e) => Some(&**e),
            Self::AccountNotFound { .. } => None,
        }
    }
}

impl From<anchor_lang::error::Error> for PumpClientError {
    fn from(e: anchor_lang::error::Error) -> Self {
        Self::Decode(Box::new(e))
    }
}

#[cfg(feature = "client")]
impl From<solana_client::client_error::ClientError> for PumpClientError {
    fn from(e: solana_client::client_error::ClientError) -> Self {
        Self::Rpc(Box::new(e))
    }
}

pub type Result<T> = std::result::Result<T, PumpClientError>;
