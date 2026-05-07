tests := "buy_sell_instructions trade_tx_and_quotes async_client_fetchers v2_custom_quote_mint"

examples := "create_v2 create_v2_and_buy buy_v2 sell_v2 buy_amm sell_amm"

# <so-file-base-name>:<program-id> pairs for programs the local validator needs.
program_ids := "pump:6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P pump_amm:pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA pump_fees:pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ pump_agent_payments:AgenTMiC2hvxGebTsgmsD4HHBa8WEcqGFf87iwRRxLo7 mayhem_program:MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e mpl_token_metadata:metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"

default:
    @just --list

build:
    cargo build --features local-validator

clone-accounts:
    cargo run --features local-validator --bin clone_devnet_accounts

local-validator: clone-accounts
    cargo run --features local-validator --bin local-validator

test:
    #!/usr/bin/env bash
    set -euo pipefail
    for t in {{tests}}; do
        echo "=== $t ==="
        cargo test --features local-validator --test "$t" -- --ignored --nocapture
    done

test-one name filter='':
    cargo test --features local-validator --test {{name}} -- --ignored --nocapture {{filter}}

examples:
    #!/usr/bin/env bash
    set -euo pipefail
    for ex in {{examples}}; do
        echo "=== $ex ==="
        cargo run --features local-validator --example "$ex"
    done

example-one name:
    cargo run --features local-validator --example {{name}}

# Dump deployed programs from devnet into artifacts/ for the local validator.
# Override cluster with e.g. `just dump-programs m` for mainnet.
dump-programs cluster="d":
    #!/usr/bin/env bash
    set -uo pipefail
    mkdir -p artifacts
    failed=0
    for entry in {{program_ids}}; do
        name="${entry%%:*}"
        id="${entry##*:}"
        dst="artifacts/${name}.so"
        echo "Dumping $name ($id) -> $dst"
        if ! solana program dump -u {{cluster}} "$id" "$dst"; then
            echo "  FAILED: $name ($id)"
            failed=$((failed + 1))
        fi
    done
    if [ "$failed" -gt 0 ]; then
        echo "$failed program(s) failed to dump."
        exit 1
    fi

build-and-test: build
    #!/usr/bin/env bash
    set -euo pipefail
    just clone-accounts
    cargo run --features local-validator --bin local-validator &
    validator_pid=$!
    trap "kill $validator_pid 2>/dev/null || true" EXIT
    sleep 10
    just test
