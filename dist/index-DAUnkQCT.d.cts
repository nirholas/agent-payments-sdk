import { Program, BN as BN$1, EventParser } from '@coral-xyz/anchor';
import { Connection, PublicKey, AccountMeta, TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import { PumpAgentPaymentsPlugin } from './solana/solana-agent-kit/index.cjs';

/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/pump_agent_payments.json`.
 */
type PumpAgentPayments = {
    address: "AgenTMiC2hvxGebTsgmsD4HHBa8WEcqGFf87iwRRxLo7";
    metadata: {
        name: "pumpAgentPayments";
        version: "0.1.0";
        spec: "0.1.0";
        description: "Created with Anchor";
    };
    instructions: [
        {
            name: "agentAcceptPayment";
            discriminator: [34, 157, 64, 220, 74, 32, 48, 225];
            accounts: [
                {
                    name: "user";
                    writable: true;
                    signer: true;
                },
                {
                    name: "userTokenAccount";
                    writable: true;
                },
                {
                    name: "tokenAgentPayments";
                },
                {
                    name: "tokenAgentAssociatedAccount";
                    writable: true;
                    pda: {
                        seeds: [
                            {
                                kind: "account";
                                path: "tokenAgentPayments";
                            },
                            {
                                kind: "const";
                                value: [6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169];
                            },
                            {
                                kind: "account";
                                path: "currencyMint";
                            }
                        ];
                        program: {
                            kind: "const";
                            value: [140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89];
                        };
                    };
                },
                {
                    name: "tokenAgentPaymentInCurrency";
                    writable: true;
                    pda: {
                        seeds: [
                            {
                                kind: "const";
                                value: [112, 97, 121, 109, 101, 110, 116, 45, 105, 110, 45, 99, 117, 114, 114, 101, 110, 99, 121];
                            },
                            {
                                kind: "account";
                                path: "tokenAgentPayments.mint";
                                account: "TokenAgentPayments";
                            },
                            {
                                kind: "account";
                                path: "currencyMint";
                            }
                        ];
                    };
                },
                {
                    name: "globalConfig";
                    pda: {
                        seeds: [{
                            kind: "const";
                            value: [103, 108, 111, 98, 97, 108, 45, 99, 111, 110, 102, 105, 103];
                        }];
                    };
                },
                {
                    name: "invoiceId";
                },
                {
                    name: "currencyMint";
                },
                {
                    name: "tokenProgram";
                },
                {
                    name: "associatedTokenProgram";
                    address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
                },
                {
                    name: "systemProgram";
                    address: "11111111111111111111111111111111";
                },
                {
                    name: "eventAuthority";
                    pda: {
                        seeds: [{
                            kind: "const";
                            value: [95, 95, 101, 118, 101, 110, 116, 95, 97, 117, 116, 104, 111, 114, 105, 116, 121];
                        }];
                    };
                },
                {
                    name: "program";
                }
            ];
            args: [
                {
                    name: "amount";
                    type: "u64";
                },
                {
                    name: "memo";
                    type: "u64";
                },
                {
                    name: "startTime";
                    type: "i64";
                },
                {
                    name: "endTime";
                    type: "i64";
                }
            ];
        },
        {
            name: "agentBuybackTrigger";
            discriminator: [95, 231, 193, 2, 245, 75, 125, 155];
            accounts: [
                {
                    name: "globalBuybackAuthority";
                    writable: true;
                    signer: true;
                },
                {
                    name: "mint";
                    writable: true;
                },
                {
                    name: "tokenAgentPayments";
                    pda: {
                        seeds: [
                            {
                                kind: "const";
                                value: [116, 111, 107, 101, 110, 45, 97, 103, 101, 110, 116, 45, 112, 97, 121, 109, 101, 110, 116, 115];
                            },
                            {
                                kind: "account";
                                path: "mint";
                            }
                        ];
                    };
                },
                {
                    name: "tokenAgentPaymentInCurrency";
                    writable: true;
                    pda: {
                        seeds: [
                            {
                                kind: "const";
                                value: [112, 97, 121, 109, 101, 110, 116, 45, 105, 110, 45, 99, 117, 114, 114, 101, 110, 99, 121];
                            },
                            {
                                kind: "account";
                                path: "tokenAgentPayments.mint";
                                account: "TokenAgentPayments";
                            },
                            {
                                kind: "account";
                                path: "currencyMint";
                            }
                        ];
                    };
                },
                {
                    name: "currencyMint";
                },
                {
                    name: "globalConfig";
                    pda: {
                        seeds: [{
                            kind: "const";
                            value: [103, 108, 111, 98, 97, 108, 45, 99, 111, 110, 102, 105, 103];
                        }];
                    };
                },
                {
                    name: "swapProgramToInvoke";
                },
                {
                    name: "burnAuthority";
                    docs: ["Intentionally called burn_authority", "TO avoid any confusion with the global buyback authority."];
                    writable: true;
                    pda: {
                        seeds: [
                            {
                                kind: "const";
                                value: [98, 117, 121, 98, 97, 99, 107, 45, 97, 117, 116, 104, 111, 114, 105, 116, 121];
                            },
                            {
                                kind: "account";
                                path: "tokenAgentPayments.mint";
                                account: "TokenAgentPayments";
                            }
                        ];
                    };
                },
                {
                    name: "burnMintVault";
                    writable: true;
                    pda: {
                        seeds: [
                            {
                                kind: "account";
                                path: "burnAuthority";
                            },
                            {
                                kind: "account";
                                path: "tokenProgram";
                            },
                            {
                                kind: "account";
                                path: "mint";
                            }
                        ];
                        program: {
                            kind: "const";
                            value: [140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89];
                        };
                    };
                },
                {
                    name: "burnCurrencyMintVault";
                    writable: true;
                    pda: {
                        seeds: [
                            {
                                kind: "account";
                                path: "burnAuthority";
                            },
                            {
                                kind: "account";
                                path: "tokenProgramCurrency";
                            },
                            {
                                kind: "account";
                                path: "currencyMint";
                            }
                        ];
                        program: {
                            kind: "const";
                            value: [140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89];
                        };
                    };
                },
                {
                    name: "tokenProgram";
                },
                {
                    name: "tokenProgramCurrency";
                },
                {
                    name: "associatedTokenProgram";
                    address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
                },
                {
                    name: "systemProgram";
                    address: "11111111111111111111111111111111";
                },
                {
                    name: "eventAuthority";
                    pda: {
                        seeds: [{
                            kind: "const";
                            value: [95, 95, 101, 118, 101, 110, 116, 95, 97, 117, 116, 104, 111, 114, 105, 116, 121];
                        }];
                    };
                },
                {
                    name: "program";
                }
            ];
            args: [{
                name: "swapInstructionData";
                type: "bytes";
            }];
        },
        {
            name: "agentDistributePayments";
            discriminator: [145, 44, 246, 47, 192, 204, 95, 32];
            accounts: [
                {
                    name: "user";
                    writable: true;
                    signer: true;
                },
                {
                    name: "globalConfig";
                    pda: {
                        seeds: [{
                            kind: "const";
                            value: [103, 108, 111, 98, 97, 108, 45, 99, 111, 110, 102, 105, 103];
                        }];
                    };
                },
                {
                    name: "currencyMint";
                },
                {
                    name: "tokenAgentPayments";
                    writable: true;
                },
                {
                    name: "tokenAgentPaymentInCurrency";
                    writable: true;
                    pda: {
                        seeds: [
                            {
                                kind: "const";
                                value: [112, 97, 121, 109, 101, 110, 116, 45, 105, 110, 45, 99, 117, 114, 114, 101, 110, 99, 121];
                            },
                            {
                                kind: "account";
                                path: "tokenAgentPayments.mint";
                                account: "TokenAgentPayments";
                            },
                            {
                                kind: "account";
                                path: "currencyMint";
                            }
                        ];
                    };
                },
                {
                    name: "tokenAgentAssociatedAccount";
                    writable: true;
                    pda: {
                        seeds: [
                            {
                                kind: "account";
                                path: "tokenAgentPayments";
                            },
                            {
                                kind: "const";
                                value: [6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169];
                            },
                            {
                                kind: "account";
                                path: "currencyMint";
                            }
                        ];
                        program: {
                            kind: "const";
                            value: [140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89];
                        };
                    };
                },
                {
                    name: "buybackAuthority";
                    pda: {
                        seeds: [
                            {
                                kind: "const";
                                value: [98, 117, 121, 98, 97, 99, 107, 45, 97, 117, 116, 104, 111, 114, 105, 116, 121];
                            },
                            {
                                kind: "account";
                                path: "tokenAgentPayments.mint";
                                account: "TokenAgentPayments";
                            }
                        ];
                    };
                },
                {
                    name: "withdrawAuthority";
                    pda: {
                        seeds: [
                            {
                                kind: "const";
                                value: [119, 105, 116, 104, 100, 114, 97, 119, 45, 97, 117, 116, 104, 111, 114, 105, 116, 121];
                            },
                            {
                                kind: "account";
                                path: "tokenAgentPayments.mint";
                                account: "TokenAgentPayments";
                            }
                        ];
                    };
                },
                {
                    name: "buybackVault";
                    writable: true;
                    pda: {
                        seeds: [
                            {
                                kind: "account";
                                path: "buybackAuthority";
                            },
                            {
                                kind: "const";
                                value: [6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169];
                            },
                            {
                                kind: "account";
                                path: "currencyMint";
                            }
                        ];
                        program: {
                            kind: "const";
                            value: [140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89];
                        };
                    };
                },
                {
                    name: "withdrawVault";
                    writable: true;
                    pda: {
                        seeds: [
                            {
                                kind: "account";
                                path: "withdrawAuthority";
                            },
                            {
                                kind: "const";
                                value: [6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169];
                            },
                            {
                                kind: "account";
                                path: "currencyMint";
                            }
                        ];
                        program: {
                            kind: "const";
                            value: [140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89];
                        };
                    };
                },
                {
                    name: "tokenProgram";
                },
                {
                    name: "associatedTokenProgram";
                    address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
                },
                {
                    name: "systemProgram";
                    address: "11111111111111111111111111111111";
                },
                {
                    name: "eventAuthority";
                    pda: {
                        seeds: [{
                            kind: "const";
                            value: [95, 95, 101, 118, 101, 110, 116, 95, 97, 117, 116, 104, 111, 114, 105, 116, 121];
                        }];
                    };
                },
                {
                    name: "program";
                }
            ];
            args: [];
        },
        {
            name: "agentInitialize";
            discriminator: [180, 248, 163, 8, 49, 94, 126, 96];
            accounts: [
                {
                    name: "authority";
                    writable: true;
                    signer: true;
                },
                {
                    name: "bondingCurve";
                    pda: {
                        seeds: [
                            {
                                kind: "const";
                                value: [98, 111, 110, 100, 105, 110, 103, 45, 99, 117, 114, 118, 101];
                            },
                            {
                                kind: "account";
                                path: "mint";
                            }
                        ];
                        program: {
                            kind: "const";
                            value: [1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170, 81, 137, 203, 151, 245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176];
                        };
                    };
                },
                {
                    name: "globalConfig";
                    writable: true;
                    pda: {
                        seeds: [{
                            kind: "const";
                            value: [103, 108, 111, 98, 97, 108, 45, 99, 111, 110, 102, 105, 103];
                        }];
                    };
                },
                {
                    name: "mint";
                },
                {
                    name: "tokenAgentPayments";
                    writable: true;
                    pda: {
                        seeds: [
                            {
                                kind: "const";
                                value: [116, 111, 107, 101, 110, 45, 97, 103, 101, 110, 116, 45, 112, 97, 121, 109, 101, 110, 116, 115];
                            },
                            {
                                kind: "account";
                                path: "mint";
                            }
                        ];
                    };
                },
                {
                    name: "systemProgram";
                    address: "11111111111111111111111111111111";
                },
                {
                    name: "eventAuthority";
                    pda: {
                        seeds: [{
                            kind: "const";
                            value: [95, 95, 101, 118, 101, 110, 116, 95, 97, 117, 116, 104, 111, 114, 105, 116, 121];
                        }];
                    };
                },
                {
                    name: "program";
                }
            ];
            args: [
                {
                    name: "authority";
                    type: "pubkey";
                },
                {
                    name: "buybackBps";
                    type: "u16";
                }
            ];
        },
        {
            name: "agentTransferExtraLamports";
            discriminator: [39, 206, 214, 167, 55, 44, 221, 81];
            accounts: [
                {
                    name: "tokenAgentPayments";
                    writable: true;
                    pda: {
                        seeds: [
                            {
                                kind: "const";
                                value: [116, 111, 107, 101, 110, 45, 97, 103, 101, 110, 116, 45, 112, 97, 121, 109, 101, 110, 116, 115];
                            },
                            {
                                kind: "account";
                                path: "tokenAgentPayments.mint";
                                account: "TokenAgentPayments";
                            }
                        ];
                    };
                },
                {
                    name: "tokenAgentAssociatedAccount";
                    writable: true;
                    pda: {
                        seeds: [
                            {
                                kind: "account";
                                path: "tokenAgentPayments";
                            },
                            {
                                kind: "const";
                                value: [6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169];
                            },
                            {
                                kind: "const";
                                value: [6, 155, 136, 87, 254, 171, 129, 132, 251, 104, 127, 99, 70, 24, 192, 53, 218, 196, 57, 220, 26, 235, 59, 85, 152, 160, 240, 0, 0, 0, 0, 1];
                            }
                        ];
                        program: {
                            kind: "const";
                            value: [140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89];
                        };
                    };
                }
            ];
            args: [];
        },
        {
            name: "agentUpdateAuthority";
            discriminator: [237, 228, 227, 224, 226, 198, 167, 83];
            accounts: [
                {
                    name: "authority";
                    writable: true;
                    signer: true;
                },
                {
                    name: "globalConfig";
                    pda: {
                        seeds: [{
                            kind: "const";
                            value: [103, 108, 111, 98, 97, 108, 45, 99, 111, 110, 102, 105, 103];
                        }];
                    };
                },
                {
                    name: "tokenAgentPayments";
                    writable: true;
                },
                {
                    name: "systemProgram";
                    address: "11111111111111111111111111111111";
                },
                {
                    name: "eventAuthority";
                    pda: {
                        seeds: [{
                            kind: "const";
                            value: [95, 95, 101, 118, 101, 110, 116, 95, 97, 117, 116, 104, 111, 114, 105, 116, 121];
                        }];
                    };
                },
                {
                    name: "program";
                }
            ];
            args: [{
                name: "newAuthority";
                type: "pubkey";
            }];
        },
        {
            name: "agentUpdateBuybackBps";
            discriminator: [41, 28, 118, 90, 53, 24, 63, 160];
            accounts: [
                {
                    name: "authority";
                    writable: true;
                    signer: true;
                },
                {
                    name: "tokenAgentPayments";
                    writable: true;
                },
                {
                    name: "globalConfig";
                    pda: {
                        seeds: [{
                            kind: "const";
                            value: [103, 108, 111, 98, 97, 108, 45, 99, 111, 110, 102, 105, 103];
                        }];
                    };
                },
                {
                    name: "eventAuthority";
                    pda: {
                        seeds: [{
                            kind: "const";
                            value: [95, 95, 101, 118, 101, 110, 116, 95, 97, 117, 116, 104, 111, 114, 105, 116, 121];
                        }];
                    };
                },
                {
                    name: "program";
                }
            ];
            args: [{
                name: "buybackBps";
                type: "u16";
            }];
        },
        {
            name: "agentWithdraw";
            discriminator: [13, 149, 99, 245, 171, 171, 185, 53];
            accounts: [
                {
                    name: "authority";
                    writable: true;
                    signer: true;
                },
                {
                    name: "tokenAgentPayments";
                },
                {
                    name: "currencyMint";
                },
                {
                    name: "withdrawAuthority";
                    pda: {
                        seeds: [
                            {
                                kind: "const";
                                value: [119, 105, 116, 104, 100, 114, 97, 119, 45, 97, 117, 116, 104, 111, 114, 105, 116, 121];
                            },
                            {
                                kind: "account";
                                path: "tokenAgentPayments.mint";
                                account: "TokenAgentPayments";
                            }
                        ];
                    };
                },
                {
                    name: "withdrawVault";
                    writable: true;
                    pda: {
                        seeds: [
                            {
                                kind: "account";
                                path: "withdrawAuthority";
                            },
                            {
                                kind: "const";
                                value: [6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169];
                            },
                            {
                                kind: "account";
                                path: "currencyMint";
                            }
                        ];
                        program: {
                            kind: "const";
                            value: [140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89];
                        };
                    };
                },
                {
                    name: "receiverAta";
                    writable: true;
                },
                {
                    name: "tokenProgram";
                },
                {
                    name: "associatedTokenProgram";
                    address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
                },
                {
                    name: "systemProgram";
                    address: "11111111111111111111111111111111";
                },
                {
                    name: "eventAuthority";
                    pda: {
                        seeds: [{
                            kind: "const";
                            value: [95, 95, 101, 118, 101, 110, 116, 95, 97, 117, 116, 104, 111, 114, 105, 116, 121];
                        }];
                    };
                },
                {
                    name: "program";
                }
            ];
            args: [];
        },
        {
            name: "closeAccount";
            discriminator: [125, 255, 149, 14, 110, 34, 72, 24];
            accounts: [
                {
                    name: "account";
                    writable: true;
                },
                {
                    name: "user";
                    writable: true;
                    signer: true;
                },
                {
                    name: "globalConfig";
                    pda: {
                        seeds: [{
                            kind: "const";
                            value: [103, 108, 111, 98, 97, 108, 45, 99, 111, 110, 102, 105, 103];
                        }];
                    };
                },
                {
                    name: "systemProgram";
                    address: "11111111111111111111111111111111";
                }
            ];
            args: [];
        },
        {
            name: "extendAccount";
            discriminator: [234, 102, 194, 203, 150, 72, 62, 229];
            accounts: [
                {
                    name: "account";
                    writable: true;
                },
                {
                    name: "user";
                    writable: true;
                    signer: true;
                },
                {
                    name: "systemProgram";
                    address: "11111111111111111111111111111111";
                },
                {
                    name: "eventAuthority";
                    pda: {
                        seeds: [{
                            kind: "const";
                            value: [95, 95, 101, 118, 101, 110, 116, 95, 97, 117, 116, 104, 111, 114, 105, 116, 121];
                        }];
                    };
                },
                {
                    name: "program";
                }
            ];
            args: [];
        },
        {
            name: "globalAddNewCurrency";
            discriminator: [46, 135, 47, 120, 118, 204, 177, 224];
            accounts: [
                {
                    name: "authority";
                    writable: true;
                    signer: true;
                },
                {
                    name: "globalConfig";
                    writable: true;
                    pda: {
                        seeds: [{
                            kind: "const";
                            value: [103, 108, 111, 98, 97, 108, 45, 99, 111, 110, 102, 105, 103];
                        }];
                    };
                },
                {
                    name: "mint";
                },
                {
                    name: "eventAuthority";
                    pda: {
                        seeds: [{
                            kind: "const";
                            value: [95, 95, 101, 118, 101, 110, 116, 95, 97, 117, 116, 104, 111, 114, 105, 116, 121];
                        }];
                    };
                },
                {
                    name: "program";
                }
            ];
            args: [];
        },
        {
            name: "globalConfigInitialize";
            discriminator: [61, 23, 208, 192, 232, 52, 8, 66];
            accounts: [
                {
                    name: "authority";
                    writable: true;
                    signer: true;
                },
                {
                    name: "globalConfig";
                    writable: true;
                    pda: {
                        seeds: [{
                            kind: "const";
                            value: [103, 108, 111, 98, 97, 108, 45, 99, 111, 110, 102, 105, 103];
                        }];
                    };
                },
                {
                    name: "systemProgram";
                    address: "11111111111111111111111111111111";
                },
                {
                    name: "eventAuthority";
                    pda: {
                        seeds: [{
                            kind: "const";
                            value: [95, 95, 101, 118, 101, 110, 116, 95, 97, 117, 116, 104, 111, 114, 105, 116, 121];
                        }];
                    };
                },
                {
                    name: "program";
                }
            ];
            args: [
                {
                    name: "protocolAuthority";
                    type: "pubkey";
                },
                {
                    name: "buybackAuthority";
                    type: "pubkey";
                }
            ];
        },
        {
            name: "globalRemoveCurrency";
            discriminator: [57, 226, 180, 140, 91, 14, 231, 196];
            accounts: [
                {
                    name: "authority";
                    writable: true;
                    signer: true;
                },
                {
                    name: "globalConfig";
                    writable: true;
                    pda: {
                        seeds: [{
                            kind: "const";
                            value: [103, 108, 111, 98, 97, 108, 45, 99, 111, 110, 102, 105, 103];
                        }];
                    };
                },
                {
                    name: "eventAuthority";
                    pda: {
                        seeds: [{
                            kind: "const";
                            value: [95, 95, 101, 118, 101, 110, 116, 95, 97, 117, 116, 104, 111, 114, 105, 116, 121];
                        }];
                    };
                },
                {
                    name: "program";
                }
            ];
            args: [{
                name: "index";
                type: "u8";
            }];
        },
        {
            name: "globalUpdateAuthorities";
            discriminator: [91, 137, 72, 77, 183, 184, 168, 125];
            accounts: [
                {
                    name: "authority";
                    writable: true;
                    signer: true;
                },
                {
                    name: "globalConfig";
                    writable: true;
                    pda: {
                        seeds: [{
                            kind: "const";
                            value: [103, 108, 111, 98, 97, 108, 45, 99, 111, 110, 102, 105, 103];
                        }];
                    };
                },
                {
                    name: "eventAuthority";
                    pda: {
                        seeds: [{
                            kind: "const";
                            value: [95, 95, 101, 118, 101, 110, 116, 95, 97, 117, 116, 104, 111, 114, 105, 116, 121];
                        }];
                    };
                },
                {
                    name: "program";
                }
            ];
            args: [
                {
                    name: "protocolAuthority";
                    type: {
                        option: "pubkey";
                    };
                },
                {
                    name: "buybackAuthority";
                    type: {
                        option: "pubkey";
                    };
                }
            ];
        }
    ];
    accounts: [
        {
            name: "BondingCurve";
            discriminator: [23, 183, 248, 55, 96, 216, 172, 96];
        },
        {
            name: "GlobalConfig";
            discriminator: [149, 8, 156, 202, 160, 252, 176, 217];
        },
        {
            name: "TokenAgentPaymentInCurrency";
            discriminator: [225, 195, 81, 227, 115, 43, 25, 177];
        },
        {
            name: "TokenAgentPayments";
            discriminator: [136, 241, 242, 217, 173, 77, 112, 186];
        }
    ];
    events: [
        {
            name: "AgentAcceptPaymentEvent";
            discriminator: [114, 190, 188, 192, 105, 79, 41, 147];
        },
        {
            name: "AgentBuybackTriggerEvent";
            discriminator: [139, 240, 9, 225, 214, 63, 232, 165];
        },
        {
            name: "AgentDistributePaymentsEvent";
            discriminator: [137, 116, 114, 140, 54, 111, 230, 26];
        },
        {
            name: "AgentInitializeEvent";
            discriminator: [192, 5, 183, 151, 0, 64, 100, 207];
        },
        {
            name: "AgentUpdateAuthorityEvent";
            discriminator: [36, 212, 117, 235, 74, 166, 60, 16];
        },
        {
            name: "AgentUpdateBuybackBpsEvent";
            discriminator: [165, 251, 40, 19, 114, 26, 128, 232];
        },
        {
            name: "AgentWithdrawEvent";
            discriminator: [174, 231, 201, 69, 254, 183, 49, 85];
        },
        {
            name: "ExtendAccountEvent";
            discriminator: [97, 97, 215, 144, 93, 146, 22, 124];
        },
        {
            name: "GlobalAddNewCurrencyEvent";
            discriminator: [130, 202, 37, 248, 241, 182, 233, 35];
        },
        {
            name: "GlobalConfigInitializeEvent";
            discriminator: [241, 51, 222, 190, 142, 245, 176, 53];
        },
        {
            name: "GlobalUpdateAuthoritiesEvent";
            discriminator: [82, 27, 22, 232, 53, 66, 35, 207];
        }
    ];
    errors: [
        {
            code: 6000;
            name: "UnauthorizedSigner";
            msg: "The given account is not authorized to execute this instruction.";
        },
        {
            code: 6001;
            name: "CurrencyAlreadySupported";
            msg: "The given currency is already supported.";
        },
        {
            code: 6002;
            name: "MaxCurrenciesReached";
            msg: "The maximum number of currencies has been reached.";
        },
        {
            code: 6003;
            name: "InvalidBuybackBps";
            msg: "The buyback basis points is greater than 10000.";
        },
        {
            code: 6004;
            name: "CurrencyNotSupported";
            msg: "The given currency is not supported.";
        },
        {
            code: 6005;
            name: "MathOverflow";
            msg: "Math overflow.";
        },
        {
            code: 6006;
            name: "InvalidRemainingAccountAddress";
            msg: "The given remaining account address is invalid.";
        },
        {
            code: 6007;
            name: "PaymentVaultNotEmpty";
            msg: "The payment vault is not empty. Distribute the payments first.";
        },
        {
            code: 6008;
            name: "InvalidInvoiceAccount";
            msg: "The invoice account does not match the expected PDA seeds";
        },
        {
            code: 6009;
            name: "InvalidProgramToInvoke";
            msg: "The program to invoke is not allowed.";
        },
        {
            code: 6010;
            name: "InvalidCallbackProgram";
            msg: "The callback program is invalid.";
        },
        {
            code: 6011;
            name: "SwapFailedAmountDidNotIncrease";
            msg: "The swap failed and the amount did not increase.";
        },
        {
            code: 6012;
            name: "AccountTypeNotSupported";
            msg: "The account type is not supported for extension.";
        },
        {
            code: 6013;
            name: "InvalidIndex";
            msg: "The index is invalid.";
        }
    ];
    types: [
        {
            name: "AgentAcceptPaymentEvent";
            type: {
                kind: "struct";
                fields: [
                    {
                        name: "user";
                        type: "pubkey";
                    },
                    {
                        name: "tokenizedAgentMint";
                        type: "pubkey";
                    },
                    {
                        name: "tokenAgentPayments";
                        type: "pubkey";
                    },
                    {
                        name: "currencyMint";
                        type: "pubkey";
                    },
                    {
                        name: "amount";
                        type: "u64";
                    },
                    {
                        name: "memo";
                        type: "u64";
                    },
                    {
                        name: "startTime";
                        type: "i64";
                    },
                    {
                        name: "endTime";
                        type: "i64";
                    },
                    {
                        name: "invoiceId";
                        type: "pubkey";
                    },
                    {
                        name: "agentPostBalance";
                        type: "u64";
                    },
                    {
                        name: "timestamp";
                        type: "i64";
                    }
                ];
            };
        },
        {
            name: "AgentBuybackTriggerEvent";
            type: {
                kind: "struct";
                fields: [
                    {
                        name: "tokenizedAgentMint";
                        type: "pubkey";
                    },
                    {
                        name: "currencyMint";
                        type: "pubkey";
                    },
                    {
                        name: "amountBurned";
                        type: "u64";
                    },
                    {
                        name: "swapProgram";
                        type: "pubkey";
                    },
                    {
                        name: "newTokensBoughtAndBurnedForCurrency";
                        type: "u64";
                    },
                    {
                        name: "agentPostBalance";
                        type: "u64";
                    },
                    {
                        name: "timestamp";
                        type: "i64";
                    },
                    {
                        name: "currencyMintAmountForBuyback";
                        type: "u64";
                    }
                ];
            };
        },
        {
            name: "AgentDistributePaymentsEvent";
            type: {
                kind: "struct";
                fields: [
                    {
                        name: "tokenAgentPayments";
                        type: "pubkey";
                    },
                    {
                        name: "currencyMint";
                        type: "pubkey";
                    },
                    {
                        name: "buybackBps";
                        type: "u16";
                    },
                    {
                        name: "buybackAmount";
                        type: "u64";
                    },
                    {
                        name: "withdrawAmount";
                        type: "u64";
                    },
                    {
                        name: "timestamp";
                        type: "i64";
                    }
                ];
            };
        },
        {
            name: "AgentInitializeEvent";
            type: {
                kind: "struct";
                fields: [
                    {
                        name: "tokenAgentPayments";
                        type: "pubkey";
                    },
                    {
                        name: "mint";
                        type: "pubkey";
                    },
                    {
                        name: "authority";
                        type: "pubkey";
                    },
                    {
                        name: "buybackBps";
                        type: "u16";
                    },
                    {
                        name: "timestamp";
                        type: "i64";
                    },
                    {
                        name: "tokenizedAgentSequence";
                        type: "u64";
                    }
                ];
            };
        },
        {
            name: "AgentUpdateAuthorityEvent";
            type: {
                kind: "struct";
                fields: [
                    {
                        name: "tokenAgentPayments";
                        type: "pubkey";
                    },
                    {
                        name: "oldAuthority";
                        type: "pubkey";
                    },
                    {
                        name: "newAuthority";
                        type: "pubkey";
                    },
                    {
                        name: "timestamp";
                        type: "i64";
                    }
                ];
            };
        },
        {
            name: "AgentUpdateBuybackBpsEvent";
            type: {
                kind: "struct";
                fields: [
                    {
                        name: "tokenAgentPayments";
                        type: "pubkey";
                    },
                    {
                        name: "mint";
                        type: "pubkey";
                    },
                    {
                        name: "oldBuybackBps";
                        type: "u16";
                    },
                    {
                        name: "newBuybackBps";
                        type: "u16";
                    },
                    {
                        name: "timestamp";
                        type: "i64";
                    }
                ];
            };
        },
        {
            name: "AgentWithdrawEvent";
            type: {
                kind: "struct";
                fields: [
                    {
                        name: "tokenizedAgentMint";
                        type: "pubkey";
                    },
                    {
                        name: "currencyMint";
                        type: "pubkey";
                    },
                    {
                        name: "amount";
                        type: "u64";
                    },
                    {
                        name: "receiver";
                        type: "pubkey";
                    },
                    {
                        name: "timestamp";
                        type: "i64";
                    }
                ];
            };
        },
        {
            name: "BondingCurve";
            type: {
                kind: "struct";
                fields: [
                    {
                        name: "virtualTokenReserves";
                        type: "u64";
                    },
                    {
                        name: "virtualSolReserves";
                        type: "u64";
                    },
                    {
                        name: "realTokenReserves";
                        type: "u64";
                    },
                    {
                        name: "realSolReserves";
                        type: "u64";
                    },
                    {
                        name: "tokenTotalSupply";
                        type: "u64";
                    },
                    {
                        name: "complete";
                        type: "bool";
                    },
                    {
                        name: "creator";
                        type: "pubkey";
                    },
                    {
                        name: "isMayhemMode";
                        type: "bool";
                    }
                ];
            };
        },
        {
            name: "ExtendAccountEvent";
            type: {
                kind: "struct";
                fields: [
                    {
                        name: "account";
                        type: "pubkey";
                    },
                    {
                        name: "user";
                        type: "pubkey";
                    },
                    {
                        name: "currentSize";
                        type: "u64";
                    },
                    {
                        name: "newSize";
                        type: "u64";
                    },
                    {
                        name: "timestamp";
                        type: "i64";
                    }
                ];
            };
        },
        {
            name: "GlobalAddNewCurrencyEvent";
            type: {
                kind: "struct";
                fields: [
                    {
                        name: "globalConfig";
                        type: "pubkey";
                    },
                    {
                        name: "currencyMint";
                        type: "pubkey";
                    },
                    {
                        name: "timestamp";
                        type: "i64";
                    }
                ];
            };
        },
        {
            name: "GlobalConfig";
            type: {
                kind: "struct";
                fields: [
                    {
                        name: "bump";
                        type: "u8";
                    },
                    {
                        name: "protocolAuthority";
                        type: "pubkey";
                    },
                    {
                        name: "buybackAuthority";
                        type: "pubkey";
                    },
                    {
                        name: "supportedCurrenciesMint";
                        type: {
                            array: ["pubkey", 10];
                        };
                    },
                    {
                        name: "tokenizedAgentSequence";
                        type: "u64";
                    }
                ];
            };
        },
        {
            name: "GlobalConfigInitializeEvent";
            type: {
                kind: "struct";
                fields: [
                    {
                        name: "globalConfig";
                        type: "pubkey";
                    },
                    {
                        name: "protocolAuthority";
                        type: "pubkey";
                    },
                    {
                        name: "buybackAuthority";
                        type: "pubkey";
                    },
                    {
                        name: "timestamp";
                        type: "i64";
                    }
                ];
            };
        },
        {
            name: "GlobalUpdateAuthoritiesEvent";
            type: {
                kind: "struct";
                fields: [
                    {
                        name: "globalConfig";
                        type: "pubkey";
                    },
                    {
                        name: "protocolAuthority";
                        type: {
                            option: "pubkey";
                        };
                    },
                    {
                        name: "buybackAuthority";
                        type: {
                            option: "pubkey";
                        };
                    },
                    {
                        name: "timestamp";
                        type: "i64";
                    }
                ];
            };
        },
        {
            name: "TokenAgentPaymentInCurrency";
            type: {
                kind: "struct";
                fields: [
                    {
                        name: "mint";
                        type: "pubkey";
                    },
                    {
                        name: "currencyMint";
                        type: "pubkey";
                    },
                    {
                        name: "totalInvoicePaymentsMade";
                        type: "u64";
                    },
                    {
                        name: "totalBuyback";
                        type: "u64";
                    },
                    {
                        name: "totalWithdrawals";
                        type: "u64";
                    },
                    {
                        name: "tokensBoughtBackAndBurned";
                        type: "u64";
                    }
                ];
            };
        },
        {
            name: "TokenAgentPayments";
            type: {
                kind: "struct";
                fields: [
                    {
                        name: "bump";
                        type: "u8";
                    },
                    {
                        name: "mint";
                        type: "pubkey";
                    },
                    {
                        name: "authority";
                        type: "pubkey";
                    },
                    {
                        name: "buybackBps";
                        type: "u16";
                    }
                ];
            };
        }
    ];
};

/**
 * Creates an Anchor Program instance for the Pump Agent Payments program.
 * Uses a dummy wallet since most operations only build instructions.
 */
declare function getPumpProgram(connection: Connection): Program<PumpAgentPayments>;
/**
 * Offline program instance (no connection required).
 * Useful for instruction building and account decoding without RPC.
 */
declare const OFFLINE_PUMP_PROGRAM: Program<PumpAgentPayments>;
/**
 * Returns the program instance, falling back to the offline program
 * if no connection is provided.
 */
declare function getPumpProgramWithFallback(connection?: Connection): Program<PumpAgentPayments>;
/**
 * Returns the offline program instance (alias for convenience).
 */
declare function getOfflineProgram(): Program<PumpAgentPayments>;

/** Pump Agent Payments program ID */
declare const PROGRAM_ID: PublicKey;
/** Pump (bonding curve) program ID */
declare const PUMP_PROGRAM_ID: PublicKey;
/** Pump fees program ID */
declare const PUMP_FEES_PROGRAM_ID: PublicKey;
declare const GLOBAL_CONFIG_SEED: Buffer<ArrayBuffer>;
declare const TOKEN_AGENT_PAYMENTS_SEED: Buffer<ArrayBuffer>;
declare const PAYMENT_IN_CURRENCY_SEED: Buffer<ArrayBuffer>;
declare const INVOICE_ID_SEED: Buffer<ArrayBuffer>;
declare const BUYBACK_AUTHORITY_SEED: Buffer<ArrayBuffer>;
declare const WITHDRAW_AUTHORITY_SEED: Buffer<ArrayBuffer>;
declare const BONDING_CURVE_SEED: Buffer<ArrayBuffer>;
declare const SHARING_CONFIG_SEED: Buffer<ArrayBuffer>;
/**
 * Minimum rent-exempt lamports for TokenAgentPayments account.
 * 0.00141288 SOL.
 */
declare const TOKEN_AGENT_PAYMENTS_MIN_RENT_EXEMPT_LAMPORTS = 1412880;
/**
 * Derives the GlobalConfig PDA.
 * Seeds: ["global-config"]
 */
declare function getGlobalConfigPDA(): [PublicKey, number];
/**
 * Derives the TokenAgentPayments PDA for a given mint.
 * Seeds: ["token-agent-payments", mint]
 */
declare function getTokenAgentPaymentsPDA(mint: PublicKey): [PublicKey, number];
/**
 * Derives the TokenAgentPaymentInCurrency PDA.
 * Seeds: ["payment-in-currency", tokenMint, currencyMint]
 */
declare function getPaymentInCurrencyPDA(tokenMint: PublicKey, currencyMint: PublicKey): [PublicKey, number];
/**
 * Derives the Invoice ID PDA used to validate payment uniqueness.
 * Seeds: ["invoice-id", tokenMint, currencyMint, amount, memo, startTime, endTime]
 */
declare function getInvoiceIdPDA(tokenMint: PublicKey, currencyMint: PublicKey, amount: BN, memo: BN, startTime: BN, endTime: BN): [PublicKey, number];
/**
 * Derives the Buyback Authority PDA for a given token mint.
 * Seeds: ["buyback-authority", tokenMint]
 */
declare function getBuybackAuthorityPDA(tokenMint: PublicKey): [PublicKey, number];
/**
 * Derives the Withdraw Authority PDA for a given token mint.
 * Seeds: ["withdraw-authority", tokenMint]
 */
declare function getWithdrawAuthorityPDA(tokenMint: PublicKey): [PublicKey, number];
/**
 * Derives the BondingCurve PDA from the Pump program for a given mint.
 * Seeds: ["bonding-curve", mint] (program = Pump)
 */
declare function getBondingCurvePDA(mint: PublicKey): [PublicKey, number];
/**
 * Derives the SharingConfig PDA for a given mint.
 * Seeds: ["sharing-config", mint]
 */
declare function getSharingConfigPDA(mint: PublicKey): [PublicKey, number];

type PumpEnvironment = "devnet" | "mainnet";
interface VaultBalance {
    address: PublicKey;
    balance: bigint;
}
interface AgentBalances {
    /** ATA of the TokenAgentPayments PDA (incoming payments land here) */
    paymentVault: VaultBalance;
    /** ATA of the Buyback Authority PDA */
    buybackVault: VaultBalance;
    /** ATA of the Withdraw Authority PDA */
    withdrawVault: VaultBalance;
}
interface CreateParams {
    /** Signer – must be the bonding-curve creator for this mint */
    authority: PublicKey;
    /** The token mint this agent manages */
    mint: PublicKey;
    /** The pubkey that will act as the agent authority (for withdraw / update) */
    agentAuthority: PublicKey;
    /** Basis points allocated to buyback (0–10 000) */
    buybackBps: number;
}
interface WithdrawParams {
    /** Agent authority signer */
    authority: PublicKey;
    /** Currency mint to withdraw */
    currencyMint: PublicKey;
    /** Receiver's token account for the currency */
    receiverAta: PublicKey;
    /** Token program for the currency mint (defaults to TOKEN_PROGRAM_ID) */
    tokenProgram?: PublicKey;
}
interface UpdateBuybackBpsParams {
    /** Agent authority signer */
    authority: PublicKey;
    /** New buyback basis points (0–10 000) */
    buybackBps: number;
}
interface UpdateBuybackBpsOptions {
    /** Supported currencies and their token programs */
    supportedCurrencies: {
        mint: PublicKey;
        tokenProgram: PublicKey;
    }[];
}
interface AcceptPaymentParams {
    /** Payer / user signer */
    user: PublicKey;
    /** User's token account holding the currency */
    userTokenAccount: PublicKey;
    /** The currency mint being paid */
    currencyMint: PublicKey;
    amount: BN$1;
    memo: BN$1;
    startTime: BN$1;
    endTime: BN$1;
    /** Token program for the currency mint (defaults to TOKEN_PROGRAM_ID) */
    tokenProgram?: PublicKey;
}
interface AcceptPaymentSimpleParams {
    user: PublicKey;
    userTokenAccount: PublicKey;
    currencyMint: PublicKey;
    amount: bigint | number | string;
    memo: bigint | number | string;
    startTime: bigint | number | string;
    endTime: bigint | number | string;
    tokenProgram?: PublicKey;
    /** Compute unit limit (defaults to 130_000) */
    computeUnitLimit?: number;
    /** Priority fee in micro lamports per compute unit (defaults to 1_000) */
    computeUnitPrice?: number;
}
interface BuildAcceptPaymentParams {
    user: PublicKey;
    currencyMint: PublicKey;
    amount: bigint | number | string;
    memo: bigint | number | string;
    startTime: bigint | number | string;
    endTime: bigint | number | string;
    tokenProgram?: PublicKey;
    /** Compute unit limit for the transaction (defaults to 100_000) */
    computeUnitLimit?: number;
    /** Priority fee in microlamports per compute unit. If provided, a SetComputeUnitPrice instruction is prepended. */
    computeUnitPrice?: number;
}
interface DistributePaymentsParams {
    /** Any signer (permissionless) */
    user: PublicKey;
    /** Currency mint to distribute */
    currencyMint: PublicKey;
    /** Token program for the currency mint (defaults to TOKEN_PROGRAM_ID) */
    tokenProgram?: PublicKey;
    /**
     * For native SOL only: prepend `agentTransferExtraLamports` before distribute.
     * Default is false.
     */
    includeTransferExtraLamportsForNative?: boolean;
}
interface BuybackTriggerParams {
    /** Must match globalConfig.buybackAuthority */
    globalBuybackAuthority: PublicKey;
    /** The currency mint used for the swap (tracks per-currency buyback accounting) */
    currencyMint: PublicKey;
    /** Swap program to CPI into (must be in the allowed list) */
    swapProgramToInvoke: PublicKey;
    /** Serialised swap instruction data (pass empty Buffer to skip swap & just burn) */
    swapInstructionData: Buffer;
    /** All accounts the swap instruction requires */
    remainingAccounts: AccountMeta[];
    /** Token program for the currency mint (defaults to TOKEN_PROGRAM_ID) */
    tokenProgramCurrency?: PublicKey;
    /** Token program for the agent token mint (defaults to TOKEN_PROGRAM_ID) */
    tokenProgram?: PublicKey;
}
interface ExtendAccountParams {
    /** Account to extend (must be a supported account type on-chain) */
    account: PublicKey;
    /** Signer paying rent for extension */
    user: PublicKey;
}
interface UpdateAuthorityParams {
    /** Current agent authority signer (or protocol authority for recovery) */
    authority: PublicKey;
    /** The new authority pubkey to set */
    newAuthority: PublicKey;
}
interface CloseAccountParams {
    /** The account to close (TokenAgentPayments, PaymentInCurrency, etc.) */
    account: PublicKey;
    /** Signer who receives the reclaimed rent lamports */
    user: PublicKey;
}

type GlobalConfig = Awaited<ReturnType<typeof OFFLINE_PUMP_PROGRAM.account.GlobalConfig.fetch>>;
type TokenAgentPaymentInCurrency = Awaited<ReturnType<typeof OFFLINE_PUMP_PROGRAM.account.TokenAgentPaymentInCurrency.fetch>>;
type TokenAgentPayments = Awaited<ReturnType<typeof OFFLINE_PUMP_PROGRAM.account.TokenAgentPayments.fetch>>;

declare class PumpAgentOffline {
    readonly mint: PublicKey;
    protected readonly program: Program<PumpAgentPayments>;
    static readonly DEFAULT_COMPUTE_UNIT_LIMIT_FOR_AGENT_PAYMENTS = 100000;
    static readonly DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS = 1000;
    constructor(mint: PublicKey, program?: Program<PumpAgentPayments>);
    static load(mint: PublicKey, connection?: Connection): PumpAgentOffline;
    create(params: CreateParams): Promise<TransactionInstruction>;
    withdraw(params: WithdrawParams): Promise<TransactionInstruction>;
    updateBuybackBps(params: UpdateBuybackBpsParams, options: UpdateBuybackBpsOptions): Promise<TransactionInstruction>;
    acceptPayment(params: AcceptPaymentParams): Promise<TransactionInstruction>;
    buildAcceptPaymentInstructions(params: BuildAcceptPaymentParams): Promise<TransactionInstruction[]>;
    distributePayments(params: DistributePaymentsParams): Promise<TransactionInstruction[]>;
    buybackTrigger(params: BuybackTriggerParams): Promise<TransactionInstruction>;
    extendAccount(params: ExtendAccountParams): Promise<TransactionInstruction>;
    updateAuthority(params: UpdateAuthorityParams): Promise<TransactionInstruction>;
    /**
     * Returns the `close_account` instruction to close a program account
     * and reclaim its rent-exempt lamports.
     */
    closeAccount(params: CloseAccountParams): Promise<TransactionInstruction>;
}

interface AgentAcceptPaymentEvent {
    user: PublicKey;
    tokenizedAgentMint: PublicKey;
    tokenAgentPayments: PublicKey;
    currencyMint: PublicKey;
    amount: BN$1;
    memo: BN$1;
    startTime: BN$1;
    endTime: BN$1;
    invoiceId: PublicKey;
    agentPostBalance: BN$1;
    timestamp: BN$1;
}
interface AgentBuybackTriggerEvent {
    tokenizedAgentMint: PublicKey;
    currencyMint: PublicKey;
    amountBurned: BN$1;
    swapProgram: PublicKey;
    newTokensBoughtAndBurnedForCurrency: BN$1;
    agentPostBalance: BN$1;
    timestamp: BN$1;
    currencyMintAmountForBuyback: BN$1;
}
interface AgentDistributePaymentsEvent {
    tokenAgentPayments: PublicKey;
    currencyMint: PublicKey;
    buybackBps: number;
    buybackAmount: BN$1;
    withdrawAmount: BN$1;
    timestamp: BN$1;
}
interface AgentInitializeEvent {
    tokenAgentPayments: PublicKey;
    mint: PublicKey;
    authority: PublicKey;
    buybackBps: number;
    timestamp: BN$1;
    tokenizedAgentSequence: BN$1;
}
interface AgentUpdateAuthorityEvent {
    tokenAgentPayments: PublicKey;
    oldAuthority: PublicKey;
    newAuthority: PublicKey;
    timestamp: BN$1;
}
interface AgentUpdateBuybackBpsEvent {
    tokenAgentPayments: PublicKey;
    mint: PublicKey;
    oldBuybackBps: number;
    newBuybackBps: number;
    timestamp: BN$1;
}
interface AgentWithdrawEvent {
    tokenizedAgentMint: PublicKey;
    currencyMint: PublicKey;
    amount: BN$1;
    receiver: PublicKey;
    timestamp: BN$1;
}
interface ExtendAccountEvent {
    account: PublicKey;
    user: PublicKey;
    currentSize: BN$1;
    newSize: BN$1;
    timestamp: BN$1;
}
interface GlobalAddNewCurrencyEvent {
    globalConfig: PublicKey;
    currencyMint: PublicKey;
    timestamp: BN$1;
}
interface GlobalConfigInitializeEvent {
    globalConfig: PublicKey;
    protocolAuthority: PublicKey;
    buybackAuthority: PublicKey;
    timestamp: BN$1;
}
interface GlobalUpdateAuthoritiesEvent {
    globalConfig: PublicKey;
    protocolAuthority: PublicKey | null;
    buybackAuthority: PublicKey | null;
    timestamp: BN$1;
}
type AgentEventName = "agentAcceptPaymentEvent" | "agentBuybackTriggerEvent" | "agentDistributePaymentsEvent" | "agentInitializeEvent" | "agentUpdateAuthorityEvent" | "agentUpdateBuybackBpsEvent" | "agentWithdrawEvent" | "extendAccountEvent" | "globalAddNewCurrencyEvent" | "globalConfigInitializeEvent" | "globalUpdateAuthoritiesEvent";
type AgentEventData = AgentAcceptPaymentEvent | AgentBuybackTriggerEvent | AgentDistributePaymentsEvent | AgentInitializeEvent | AgentUpdateAuthorityEvent | AgentUpdateBuybackBpsEvent | AgentWithdrawEvent | ExtendAccountEvent | GlobalAddNewCurrencyEvent | GlobalConfigInitializeEvent | GlobalUpdateAuthoritiesEvent;
interface ParsedAgentEvent<T extends AgentEventData = AgentEventData> {
    name: AgentEventName;
    data: T;
}
/**
 * Create an Anchor EventParser bound to the Pump Agent Payments program.
 * Works offline (no connection required) or with a connection.
 */
declare function createEventParser(connection?: Connection): EventParser;
/**
 * Parse transaction log messages into typed agent events.
 *
 * @example
 * ```ts
 * const tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
 * const events = parseAgentEvents(tx.meta.logMessages);
 * for (const event of events) {
 *   if (event.name === "agentAcceptPaymentEvent") {
 *     console.log("Payment:", event.data.amount.toString());
 *   }
 * }
 * ```
 */
declare function parseAgentEvents(logs: string[], connection?: Connection): ParsedAgentEvent[];
interface EventSubscriptionOptions {
    /** Filter to specific event names. If omitted, all events are emitted. */
    eventNames?: AgentEventName[];
}
interface EventSubscription {
    /** Stop listening and clean up the WebSocket subscription. */
    unsubscribe(): void;
}
/**
 * Subscribe to real-time Pump Agent Payments program events via WebSocket.
 * Calls the provided callback whenever a matching event is detected.
 *
 * @example
 * ```ts
 * const sub = subscribeToAgentEvents(connection, (event, slot) => {
 *   console.log(`[slot ${slot}] ${event.name}`, event.data);
 * }, { eventNames: ["agentAcceptPaymentEvent"] });
 *
 * // Later: stop listening
 * sub.unsubscribe();
 * ```
 */
declare function subscribeToAgentEvents(connection: Connection, callback: (event: ParsedAgentEvent, slot: number) => void, options?: EventSubscriptionOptions): EventSubscription;

declare class PumpAgent extends PumpAgentOffline {
    private connection?;
    private environment;
    constructor(mint: PublicKey, environment?: PumpEnvironment, connection?: Connection);
    private get blockchainClientBaseUrl();
    /**
     * Fetches the current balances for all three vaults for a given currency.
     * Returns the vault address and its token balance.
     * If a vault ATA does not exist yet the balance is reported as 0n.
     */
    getBalances(currencyMint: PublicKey, currencyTokenProgram?: PublicKey): Promise<AgentBalances>;
    /**
     * Returns the `agent_update_buyback_bps` instruction and auto-fetches
     * supported currencies from GlobalConfig when options are omitted.
     */
    updateBuybackBps(params: UpdateBuybackBpsParams): Promise<TransactionInstruction>;
    /**
     * Fetch the on-chain TokenAgentPayments config for this agent's mint.
     * Returns the authority, buyback bps, and mint.
     */
    getAgentConfig(): Promise<TokenAgentPayments>;
    /**
     * Fetch the protocol-wide GlobalConfig account.
     * Returns authorities and the list of supported currency mints.
     */
    getGlobalConfig(): Promise<GlobalConfig>;
    /**
     * Fetch the per-currency accounting stats for this agent.
     * Returns total payments, buybacks, withdrawals, and tokens burned.
     */
    getPaymentStats(currencyMint: PublicKey): Promise<TokenAgentPaymentInCurrency>;
    /**
     * Fetch the list of supported currency mints from GlobalConfig,
     * filtered to only non-default (non-zero) entries.
     */
    getSupportedCurrencies(): Promise<PublicKey[]>;
    /**
     * Check whether the TokenAgentPayments account exists on-chain
     * (i.e. whether this agent has been initialized).
     */
    isInitialized(): Promise<boolean>;
    /**
     * Fetch recent payment events for this agent by scanning on-chain
     * transaction logs on the TokenAgentPayments PDA.
     *
     * @param limit - Maximum number of transactions to scan (default: 50)
     * @returns Parsed `AgentAcceptPaymentEvent`s in reverse chronological order
     */
    getPaymentHistory(limit?: number): Promise<AgentAcceptPaymentEvent[]>;
    /**
     * Fetch all recent events for this agent (payments, distributions,
     * buybacks, withdrawals, etc.) from on-chain transaction logs.
     *
     * @param limit - Maximum number of transactions to scan (default: 50)
     */
    getEventHistory(limit?: number): Promise<ParsedAgentEvent[]>;
    validateInvoicePayment(params: {
        user: PublicKey;
        currencyMint: PublicKey;
        amount: number;
        memo: number;
        startTime: number;
        endTime: number;
    }): Promise<boolean>;
    /** RPC-based fallback: scans on-chain transaction logs for the payment event. */
    private validateInvoicePaymentViaRpc;
}

declare function decodeGlobalConfig(accountData: Buffer): GlobalConfig;
declare function decodeTokenAgentPaymentInCurrency(accountData: Buffer): TokenAgentPaymentInCurrency;
declare function decodeTokenAgentPayments(accountData: Buffer): TokenAgentPayments;

/**
 * x402 v2 Protocol Types
 *
 * Aligned with the coinbase/x402 specification.
 * Supports "pump-agent" scheme (on-chain invoice payments) and
 * the standard "exact" scheme (SPL TransferChecked).
 *
 * @see https://github.com/coinbase/x402
 */
declare const X402_VERSION = 2;
/** Standard x402 header names (v2 spec) */
declare const X402_HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
declare const X402_HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
declare const X402_HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE";
/** CAIP-2 network identifiers for Solana */
declare const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
declare const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
/** Well-known Solana asset addresses */
declare const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
declare const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
/** Standard x402 "exact" scheme – SPL TransferChecked */
type ExactScheme = "exact";
/** Pump Agent invoice scheme */
type PumpAgentScheme = "pump-agent";
/** Supported payment schemes */
type PaymentScheme = ExactScheme | PumpAgentScheme;
interface ResourceInfo {
    /** The URL of the paid resource */
    url: string;
    /** Human-readable description */
    description?: string;
}
/** Base fields shared by all schemes */
interface PaymentRequirementsBase {
    /** Payment scheme identifier */
    scheme: PaymentScheme;
    /** CAIP-2 network identifier */
    network: string;
    /** Token/asset mint address (base58) */
    asset: string;
    /** Amount in minor units (string to avoid floating point) */
    amount: string;
    /** Recipient address (base58) */
    payTo: string;
    /** Max seconds the facilitator will wait for settlement */
    maxTimeoutSeconds: number;
    /** Scheme-specific extra data */
    extra?: Record<string, unknown>;
}
/** "exact" scheme – standard SPL TransferChecked */
interface ExactPaymentRequirements extends PaymentRequirementsBase {
    scheme: "exact";
}
/** "pump-agent" scheme – Pump Agent on-chain invoice */
interface PumpAgentPaymentRequirements extends PaymentRequirementsBase {
    scheme: "pump-agent";
    extra: {
        /** Agent token mint (base58) */
        agentMint: string;
        /** Numeric invoice memo */
        memo: string;
        /** Unix timestamp – invoice valid from */
        startTime: number;
        /** Unix timestamp – invoice valid until */
        endTime: number;
    };
}
/** Union of all supported requirements */
type PaymentRequirements = ExactPaymentRequirements | PumpAgentPaymentRequirements;
interface PaymentRequired {
    x402Version: 2;
    error?: string;
    resource: ResourceInfo;
    accepts: PaymentRequirements[];
}
interface PaymentPayload {
    x402Version: 2;
    /** The resource URL this payment is for */
    resource?: string;
    /** Which accepted scheme/requirements this payment matches */
    accepted: PaymentRequirements;
    /** Scheme-specific proof data */
    payload: Record<string, unknown>;
}
interface VerifyResponse {
    isValid: boolean;
    invalidReason?: string;
    payer?: string;
}
interface SettleResponse {
    success: boolean;
    errorReason?: string;
    payer?: string;
    transaction?: string;
    network?: string;
}
interface SupportedKind {
    scheme: PaymentScheme;
    network: string;
    asset: string;
}
interface SupportedResponse {
    kinds: SupportedKind[];
}
interface FacilitatorClient {
    /** Verify a payment payload against its requirements */
    verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
    /** Settle (submit) a verified payment and return the result */
    settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
    /** Return the schemes/networks/assets this facilitator supports */
    getSupported(): Promise<SupportedResponse>;
}
interface PaymentResponse {
    success: boolean;
    transaction?: string;
    network?: string;
    payer?: string;
    errorReason?: string;
}
interface ResourceServerConfig {
    /** Facilitator client to use for verify + settle */
    facilitator: FacilitatorClient;
    /** Default payment requirements for this resource */
    requirements: PaymentRequirements[];
    /** Resource info describing what's for sale */
    resource: ResourceInfo;
}
type TransactionSigner = (txBase64: string) => Promise<string>;
type TransactionSender = (signedTxBase64: string) => Promise<string>;
interface X402ClientConfig {
    /** Payer's public key (base58) */
    payer: string;
    /** Sign a serialised transaction, return signed base64 */
    signTransaction: TransactionSigner;
    /** Send a signed transaction, return the tx signature (base58) */
    sendTransaction: TransactionSender;
    /** CAIP-2 network identifier (default: SOLANA_MAINNET) */
    network?: string;
    /** Max time to wait for tx confirmation in ms (default: 30_000) */
    confirmationTimeoutMs?: number;
}

/**
 * x402 v2 Header encoding / decoding
 *
 * Standard headers (per coinbase/x402 v2 spec):
 *   PAYMENT-REQUIRED   – server → client (402 response)
 *   PAYMENT-SIGNATURE  – client → server (retry request)
 *   PAYMENT-RESPONSE   – server → client (200 after settlement)
 *
 * All values are base64-encoded JSON.
 */

declare function encodePaymentRequired(pr: PaymentRequired): string;
declare function decodePaymentRequired(headerValue: string): PaymentRequired;
declare function encodePaymentPayload(payload: PaymentPayload): string;
declare function decodePaymentPayload(headerValue: string): PaymentPayload;
declare function encodePaymentResponse(pr: PaymentResponse): string;
declare function decodePaymentResponse(headerValue: string): PaymentResponse;
/**
 * Extract PAYMENT-REQUIRED from a 402 Response.
 * Returns null if not a 402 or header is missing.
 */
declare function getPaymentRequiredFromResponse(response: Response): PaymentRequired | null;
/**
 * Extract PAYMENT-SIGNATURE from a Request.
 * Returns null if header is missing.
 */
declare function getPaymentPayloadFromRequest(request: Request): PaymentPayload | null;
/**
 * Extract PAYMENT-RESPONSE from a Response.
 * Returns null if header is missing.
 */
declare function getPaymentResponseFromResponse(response: Response): PaymentResponse | null;

/**
 * x402 v2 Facilitator & Resource Server
 *
 * Implements the coinbase/x402 3-party architecture:
 *   Client → Resource Server → Facilitator (verify / settle)
 *
 * Provides:
 *   - PumpAgentFacilitator: FacilitatorClient that verifies & settles
 *     "pump-agent" scheme payments using PumpAgent on-chain validation.
 *   - createResourceServer: framework-agnostic Request/Response middleware
 *     that returns 402s, verifies payment via a facilitator, and settles.
 */

interface PumpAgentFacilitatorConfig {
    /** Solana RPC connection */
    connection: Connection;
    /** CAIP-2 network (default: SOLANA_MAINNET) */
    network?: string;
}
/**
 * FacilitatorClient implementation for the "pump-agent" scheme.
 *
 * Uses PumpAgent.validateInvoicePayment() for on-chain verification,
 * and treats the client-submitted transaction signature as the settlement.
 */
declare class PumpAgentFacilitator implements FacilitatorClient {
    private connection;
    private network;
    private settlementCache;
    constructor(config: PumpAgentFacilitatorConfig);
    verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
    settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
    getSupported(): Promise<SupportedResponse>;
}
interface PumpAgentRequirementsConfig {
    /** Agent token mint (base58) */
    agentMint: string;
    /** Currency / asset mint (base58). Defaults to USDC mainnet */
    asset?: string;
    /** Recipient address (generally the payment vault) */
    payTo: string;
    /** Price in minor units */
    amount: string;
    /** CAIP-2 network (default: SOLANA_MAINNET) */
    network?: string;
    /** Invoice window in seconds (default: 300) */
    invoiceWindowSeconds?: number;
    /** Max settlement timeout in seconds (default: 60) */
    maxTimeoutSeconds?: number;
}
/**
 * Build fresh PumpAgentPaymentRequirements with a unique invoice memo.
 */
declare function buildPumpAgentRequirements(config: PumpAgentRequirementsConfig): PumpAgentPaymentRequirements;
/**
 * Creates a handler wrapper that implements the x402 Resource Server role.
 *
 * On requests without PAYMENT-SIGNATURE: returns 402 with PAYMENT-REQUIRED.
 * On requests with PAYMENT-SIGNATURE: verifies → settles → forwards to handler.
 *
 * Works with any framework using the standard Request/Response API
 * (Hono, Next.js App Router, Cloudflare Workers, Bun, Deno, etc.).
 *
 * @example
 * ```ts
 * const gate = createResourceServer({
 *   facilitator: new PumpAgentFacilitator({ connection }),
 *   requirements: [buildPumpAgentRequirements({
 *     agentMint: "YourMint...",
 *     payTo: "PaymentVault...",
 *     amount: "1000000",
 *   })],
 *   resource: { url: "/api/inference", description: "AI call" },
 * });
 *
 * // Hono
 * app.get("/api/inference", (c) =>
 *   gate(c.req.raw, () => c.json({ result: "..." }))
 * );
 * ```
 */
declare function createResourceServer(config: ResourceServerConfig): (request: Request, handler: () => Response | Promise<Response>) => Promise<Response>;

/**
 * x402 v2 Client – automatic 402 handling
 *
 * A fetch wrapper that intercepts HTTP 402 responses, builds and signs
 * a payment transaction matching the server's PaymentRequirements, and
 * retries the request with a PAYMENT-SIGNATURE header.
 *
 * Supports both "pump-agent" (Pump Agent invoice) and "exact" (SPL
 * TransferChecked) schemes.
 */

/**
 * Create a fetch function that automatically handles HTTP 402 responses
 * by building a payment transaction, signing, sending, and retrying
 * the original request with payment proof in the PAYMENT-SIGNATURE header.
 *
 * @example
 * ```ts
 * import { createX402Fetch } from "@pump-fun/agent-payments-sdk/x402";
 *
 * const x402fetch = createX402Fetch({
 *   payer: wallet.publicKey.toBase58(),
 *   signTransaction: async (txBase64) => {
 *     const tx = Transaction.from(Buffer.from(txBase64, "base64"));
 *     const signed = await wallet.signTransaction(tx);
 *     return Buffer.from(signed.serialize()).toString("base64");
 *   },
 *   sendTransaction: async (signedTxBase64) => {
 *     const raw = Buffer.from(signedTxBase64, "base64");
 *     const sig = await connection.sendRawTransaction(raw);
 *     await connection.confirmTransaction(sig, "confirmed");
 *     return sig;
 *   },
 * });
 *
 * const res = await x402fetch("https://api.agent.example/inference", {
 *   method: "POST",
 *   body: JSON.stringify({ prompt: "Hello" }),
 * });
 * ```
 */
declare function createX402Fetch(config: X402ClientConfig & {
    connection: Connection;
}): typeof fetch;

/**
 * x402 v2 – HTTP 402 Payment Required protocol for Pump Agent Payments
 *
 * Aligned with the coinbase/x402 v2 specification.
 * @see https://github.com/coinbase/x402
 *
 * Server-side:  PumpAgentFacilitator, createResourceServer, buildPumpAgentRequirements
 * Client-side:  createX402Fetch
 * Helpers:      encode/decode headers, constants
 */

type index$1_ExactPaymentRequirements = ExactPaymentRequirements;
type index$1_ExactScheme = ExactScheme;
type index$1_FacilitatorClient = FacilitatorClient;
type index$1_PaymentPayload = PaymentPayload;
type index$1_PaymentRequired = PaymentRequired;
type index$1_PaymentRequirements = PaymentRequirements;
type index$1_PaymentRequirementsBase = PaymentRequirementsBase;
type index$1_PaymentResponse = PaymentResponse;
type index$1_PaymentScheme = PaymentScheme;
type index$1_PumpAgentFacilitator = PumpAgentFacilitator;
declare const index$1_PumpAgentFacilitator: typeof PumpAgentFacilitator;
type index$1_PumpAgentFacilitatorConfig = PumpAgentFacilitatorConfig;
type index$1_PumpAgentPaymentRequirements = PumpAgentPaymentRequirements;
type index$1_PumpAgentRequirementsConfig = PumpAgentRequirementsConfig;
type index$1_PumpAgentScheme = PumpAgentScheme;
type index$1_ResourceInfo = ResourceInfo;
type index$1_ResourceServerConfig = ResourceServerConfig;
declare const index$1_SOLANA_DEVNET: typeof SOLANA_DEVNET;
declare const index$1_SOLANA_MAINNET: typeof SOLANA_MAINNET;
type index$1_SettleResponse = SettleResponse;
type index$1_SupportedKind = SupportedKind;
type index$1_SupportedResponse = SupportedResponse;
type index$1_TransactionSender = TransactionSender;
type index$1_TransactionSigner = TransactionSigner;
declare const index$1_USDC_DEVNET: typeof USDC_DEVNET;
declare const index$1_USDC_MAINNET: typeof USDC_MAINNET;
type index$1_VerifyResponse = VerifyResponse;
type index$1_X402ClientConfig = X402ClientConfig;
declare const index$1_X402_HEADER_PAYMENT_REQUIRED: typeof X402_HEADER_PAYMENT_REQUIRED;
declare const index$1_X402_HEADER_PAYMENT_RESPONSE: typeof X402_HEADER_PAYMENT_RESPONSE;
declare const index$1_X402_HEADER_PAYMENT_SIGNATURE: typeof X402_HEADER_PAYMENT_SIGNATURE;
declare const index$1_X402_VERSION: typeof X402_VERSION;
declare const index$1_buildPumpAgentRequirements: typeof buildPumpAgentRequirements;
declare const index$1_createResourceServer: typeof createResourceServer;
declare const index$1_createX402Fetch: typeof createX402Fetch;
declare const index$1_decodePaymentPayload: typeof decodePaymentPayload;
declare const index$1_decodePaymentRequired: typeof decodePaymentRequired;
declare const index$1_decodePaymentResponse: typeof decodePaymentResponse;
declare const index$1_encodePaymentPayload: typeof encodePaymentPayload;
declare const index$1_encodePaymentRequired: typeof encodePaymentRequired;
declare const index$1_encodePaymentResponse: typeof encodePaymentResponse;
declare const index$1_getPaymentPayloadFromRequest: typeof getPaymentPayloadFromRequest;
declare const index$1_getPaymentRequiredFromResponse: typeof getPaymentRequiredFromResponse;
declare const index$1_getPaymentResponseFromResponse: typeof getPaymentResponseFromResponse;
declare namespace index$1 {
  export { type index$1_ExactPaymentRequirements as ExactPaymentRequirements, type index$1_ExactScheme as ExactScheme, type index$1_FacilitatorClient as FacilitatorClient, type index$1_PaymentPayload as PaymentPayload, type index$1_PaymentRequired as PaymentRequired, type index$1_PaymentRequirements as PaymentRequirements, type index$1_PaymentRequirementsBase as PaymentRequirementsBase, type index$1_PaymentResponse as PaymentResponse, type index$1_PaymentScheme as PaymentScheme, index$1_PumpAgentFacilitator as PumpAgentFacilitator, type index$1_PumpAgentFacilitatorConfig as PumpAgentFacilitatorConfig, type index$1_PumpAgentPaymentRequirements as PumpAgentPaymentRequirements, type index$1_PumpAgentRequirementsConfig as PumpAgentRequirementsConfig, type index$1_PumpAgentScheme as PumpAgentScheme, type index$1_ResourceInfo as ResourceInfo, type index$1_ResourceServerConfig as ResourceServerConfig, index$1_SOLANA_DEVNET as SOLANA_DEVNET, index$1_SOLANA_MAINNET as SOLANA_MAINNET, type index$1_SettleResponse as SettleResponse, type index$1_SupportedKind as SupportedKind, type index$1_SupportedResponse as SupportedResponse, type index$1_TransactionSender as TransactionSender, type index$1_TransactionSigner as TransactionSigner, index$1_USDC_DEVNET as USDC_DEVNET, index$1_USDC_MAINNET as USDC_MAINNET, type index$1_VerifyResponse as VerifyResponse, type index$1_X402ClientConfig as X402ClientConfig, index$1_X402_HEADER_PAYMENT_REQUIRED as X402_HEADER_PAYMENT_REQUIRED, index$1_X402_HEADER_PAYMENT_RESPONSE as X402_HEADER_PAYMENT_RESPONSE, index$1_X402_HEADER_PAYMENT_SIGNATURE as X402_HEADER_PAYMENT_SIGNATURE, index$1_X402_VERSION as X402_VERSION, index$1_buildPumpAgentRequirements as buildPumpAgentRequirements, index$1_createResourceServer as createResourceServer, index$1_createX402Fetch as createX402Fetch, index$1_decodePaymentPayload as decodePaymentPayload, index$1_decodePaymentRequired as decodePaymentRequired, index$1_decodePaymentResponse as decodePaymentResponse, index$1_encodePaymentPayload as encodePaymentPayload, index$1_encodePaymentRequired as encodePaymentRequired, index$1_encodePaymentResponse as encodePaymentResponse, index$1_getPaymentPayloadFromRequest as getPaymentPayloadFromRequest, index$1_getPaymentRequiredFromResponse as getPaymentRequiredFromResponse, index$1_getPaymentResponseFromResponse as getPaymentResponseFromResponse };
}

/**
 * @pump-fun/agent-payments-sdk
 * TypeScript SDK for Pump Agent Payments
 */

declare const PUMP_AGENT_PAYMENTS_PROGRAM_ID: PublicKey;
declare function getProgram(connection: Connection): Program<PumpAgentPayments>;

type index_AcceptPaymentParams = AcceptPaymentParams;
type index_AcceptPaymentSimpleParams = AcceptPaymentSimpleParams;
type index_AgentAcceptPaymentEvent = AgentAcceptPaymentEvent;
type index_AgentBalances = AgentBalances;
type index_AgentBuybackTriggerEvent = AgentBuybackTriggerEvent;
type index_AgentDistributePaymentsEvent = AgentDistributePaymentsEvent;
type index_AgentEventData = AgentEventData;
type index_AgentEventName = AgentEventName;
type index_AgentInitializeEvent = AgentInitializeEvent;
type index_AgentUpdateAuthorityEvent = AgentUpdateAuthorityEvent;
type index_AgentUpdateBuybackBpsEvent = AgentUpdateBuybackBpsEvent;
type index_AgentWithdrawEvent = AgentWithdrawEvent;
declare const index_BONDING_CURVE_SEED: typeof BONDING_CURVE_SEED;
declare const index_BUYBACK_AUTHORITY_SEED: typeof BUYBACK_AUTHORITY_SEED;
type index_BuildAcceptPaymentParams = BuildAcceptPaymentParams;
type index_BuybackTriggerParams = BuybackTriggerParams;
type index_CloseAccountParams = CloseAccountParams;
type index_CreateParams = CreateParams;
type index_DistributePaymentsParams = DistributePaymentsParams;
type index_EventSubscription = EventSubscription;
type index_EventSubscriptionOptions = EventSubscriptionOptions;
type index_ExtendAccountEvent = ExtendAccountEvent;
type index_ExtendAccountParams = ExtendAccountParams;
declare const index_GLOBAL_CONFIG_SEED: typeof GLOBAL_CONFIG_SEED;
type index_GlobalAddNewCurrencyEvent = GlobalAddNewCurrencyEvent;
type index_GlobalConfig = GlobalConfig;
type index_GlobalConfigInitializeEvent = GlobalConfigInitializeEvent;
type index_GlobalUpdateAuthoritiesEvent = GlobalUpdateAuthoritiesEvent;
declare const index_INVOICE_ID_SEED: typeof INVOICE_ID_SEED;
declare const index_OFFLINE_PUMP_PROGRAM: typeof OFFLINE_PUMP_PROGRAM;
declare const index_PAYMENT_IN_CURRENCY_SEED: typeof PAYMENT_IN_CURRENCY_SEED;
declare const index_PROGRAM_ID: typeof PROGRAM_ID;
declare const index_PUMP_AGENT_PAYMENTS_PROGRAM_ID: typeof PUMP_AGENT_PAYMENTS_PROGRAM_ID;
declare const index_PUMP_FEES_PROGRAM_ID: typeof PUMP_FEES_PROGRAM_ID;
declare const index_PUMP_PROGRAM_ID: typeof PUMP_PROGRAM_ID;
type index_ParsedAgentEvent<T extends AgentEventData = AgentEventData> = ParsedAgentEvent<T>;
type index_PumpAgent = PumpAgent;
declare const index_PumpAgent: typeof PumpAgent;
type index_PumpAgentOffline = PumpAgentOffline;
declare const index_PumpAgentOffline: typeof PumpAgentOffline;
type index_PumpAgentPayments = PumpAgentPayments;
declare const index_PumpAgentPaymentsPlugin: typeof PumpAgentPaymentsPlugin;
type index_PumpEnvironment = PumpEnvironment;
declare const index_SHARING_CONFIG_SEED: typeof SHARING_CONFIG_SEED;
declare const index_TOKEN_AGENT_PAYMENTS_MIN_RENT_EXEMPT_LAMPORTS: typeof TOKEN_AGENT_PAYMENTS_MIN_RENT_EXEMPT_LAMPORTS;
declare const index_TOKEN_AGENT_PAYMENTS_SEED: typeof TOKEN_AGENT_PAYMENTS_SEED;
type index_TokenAgentPaymentInCurrency = TokenAgentPaymentInCurrency;
type index_TokenAgentPayments = TokenAgentPayments;
type index_UpdateAuthorityParams = UpdateAuthorityParams;
type index_UpdateBuybackBpsOptions = UpdateBuybackBpsOptions;
type index_UpdateBuybackBpsParams = UpdateBuybackBpsParams;
type index_VaultBalance = VaultBalance;
declare const index_WITHDRAW_AUTHORITY_SEED: typeof WITHDRAW_AUTHORITY_SEED;
type index_WithdrawParams = WithdrawParams;
declare const index_createEventParser: typeof createEventParser;
declare const index_decodeGlobalConfig: typeof decodeGlobalConfig;
declare const index_decodeTokenAgentPaymentInCurrency: typeof decodeTokenAgentPaymentInCurrency;
declare const index_decodeTokenAgentPayments: typeof decodeTokenAgentPayments;
declare const index_getBondingCurvePDA: typeof getBondingCurvePDA;
declare const index_getBuybackAuthorityPDA: typeof getBuybackAuthorityPDA;
declare const index_getGlobalConfigPDA: typeof getGlobalConfigPDA;
declare const index_getInvoiceIdPDA: typeof getInvoiceIdPDA;
declare const index_getOfflineProgram: typeof getOfflineProgram;
declare const index_getPaymentInCurrencyPDA: typeof getPaymentInCurrencyPDA;
declare const index_getProgram: typeof getProgram;
declare const index_getPumpProgram: typeof getPumpProgram;
declare const index_getPumpProgramWithFallback: typeof getPumpProgramWithFallback;
declare const index_getSharingConfigPDA: typeof getSharingConfigPDA;
declare const index_getTokenAgentPaymentsPDA: typeof getTokenAgentPaymentsPDA;
declare const index_getWithdrawAuthorityPDA: typeof getWithdrawAuthorityPDA;
declare const index_parseAgentEvents: typeof parseAgentEvents;
declare const index_subscribeToAgentEvents: typeof subscribeToAgentEvents;
declare namespace index {
  export { type index_AcceptPaymentParams as AcceptPaymentParams, type index_AcceptPaymentSimpleParams as AcceptPaymentSimpleParams, type index_AgentAcceptPaymentEvent as AgentAcceptPaymentEvent, type index_AgentBalances as AgentBalances, type index_AgentBuybackTriggerEvent as AgentBuybackTriggerEvent, type index_AgentDistributePaymentsEvent as AgentDistributePaymentsEvent, type index_AgentEventData as AgentEventData, type index_AgentEventName as AgentEventName, type index_AgentInitializeEvent as AgentInitializeEvent, type index_AgentUpdateAuthorityEvent as AgentUpdateAuthorityEvent, type index_AgentUpdateBuybackBpsEvent as AgentUpdateBuybackBpsEvent, type index_AgentWithdrawEvent as AgentWithdrawEvent, index_BONDING_CURVE_SEED as BONDING_CURVE_SEED, index_BUYBACK_AUTHORITY_SEED as BUYBACK_AUTHORITY_SEED, type index_BuildAcceptPaymentParams as BuildAcceptPaymentParams, type index_BuybackTriggerParams as BuybackTriggerParams, type index_CloseAccountParams as CloseAccountParams, type index_CreateParams as CreateParams, type index_DistributePaymentsParams as DistributePaymentsParams, type index_EventSubscription as EventSubscription, type index_EventSubscriptionOptions as EventSubscriptionOptions, type index_ExtendAccountEvent as ExtendAccountEvent, type index_ExtendAccountParams as ExtendAccountParams, index_GLOBAL_CONFIG_SEED as GLOBAL_CONFIG_SEED, type index_GlobalAddNewCurrencyEvent as GlobalAddNewCurrencyEvent, type index_GlobalConfig as GlobalConfig, type index_GlobalConfigInitializeEvent as GlobalConfigInitializeEvent, type index_GlobalUpdateAuthoritiesEvent as GlobalUpdateAuthoritiesEvent, index_INVOICE_ID_SEED as INVOICE_ID_SEED, index_OFFLINE_PUMP_PROGRAM as OFFLINE_PUMP_PROGRAM, index_PAYMENT_IN_CURRENCY_SEED as PAYMENT_IN_CURRENCY_SEED, index_PROGRAM_ID as PROGRAM_ID, index_PUMP_AGENT_PAYMENTS_PROGRAM_ID as PUMP_AGENT_PAYMENTS_PROGRAM_ID, index_PUMP_FEES_PROGRAM_ID as PUMP_FEES_PROGRAM_ID, index_PUMP_PROGRAM_ID as PUMP_PROGRAM_ID, type index_ParsedAgentEvent as ParsedAgentEvent, index_PumpAgent as PumpAgent, index_PumpAgentOffline as PumpAgentOffline, type index_PumpAgentPayments as PumpAgentPayments, index_PumpAgentPaymentsPlugin as PumpAgentPaymentsPlugin, type index_PumpEnvironment as PumpEnvironment, index_SHARING_CONFIG_SEED as SHARING_CONFIG_SEED, index_TOKEN_AGENT_PAYMENTS_MIN_RENT_EXEMPT_LAMPORTS as TOKEN_AGENT_PAYMENTS_MIN_RENT_EXEMPT_LAMPORTS, index_TOKEN_AGENT_PAYMENTS_SEED as TOKEN_AGENT_PAYMENTS_SEED, type index_TokenAgentPaymentInCurrency as TokenAgentPaymentInCurrency, type index_TokenAgentPayments as TokenAgentPayments, type index_UpdateAuthorityParams as UpdateAuthorityParams, type index_UpdateBuybackBpsOptions as UpdateBuybackBpsOptions, type index_UpdateBuybackBpsParams as UpdateBuybackBpsParams, type index_VaultBalance as VaultBalance, index_WITHDRAW_AUTHORITY_SEED as WITHDRAW_AUTHORITY_SEED, type index_WithdrawParams as WithdrawParams, index_createEventParser as createEventParser, index_decodeGlobalConfig as decodeGlobalConfig, index_decodeTokenAgentPaymentInCurrency as decodeTokenAgentPaymentInCurrency, index_decodeTokenAgentPayments as decodeTokenAgentPayments, index_getBondingCurvePDA as getBondingCurvePDA, index_getBuybackAuthorityPDA as getBuybackAuthorityPDA, index_getGlobalConfigPDA as getGlobalConfigPDA, index_getInvoiceIdPDA as getInvoiceIdPDA, index_getOfflineProgram as getOfflineProgram, index_getPaymentInCurrencyPDA as getPaymentInCurrencyPDA, index_getProgram as getProgram, index_getPumpProgram as getPumpProgram, index_getPumpProgramWithFallback as getPumpProgramWithFallback, index_getSharingConfigPDA as getSharingConfigPDA, index_getTokenAgentPaymentsPDA as getTokenAgentPaymentsPDA, index_getWithdrawAuthorityPDA as getWithdrawAuthorityPDA, index_parseAgentEvents as parseAgentEvents, index_subscribeToAgentEvents as subscribeToAgentEvents, index$1 as x402 };
}

export { decodeTokenAgentPaymentInCurrency as $, type AcceptPaymentParams as A, BONDING_CURVE_SEED as B, type CloseAccountParams as C, type DistributePaymentsParams as D, type EventSubscription as E, type ParsedAgentEvent as F, GLOBAL_CONFIG_SEED as G, PumpAgent as H, INVOICE_ID_SEED as I, PumpAgentOffline as J, type PumpAgentPayments as K, type PumpEnvironment as L, TOKEN_AGENT_PAYMENTS_SEED as M, type TokenAgentPaymentInCurrency as N, OFFLINE_PUMP_PROGRAM as O, PAYMENT_IN_CURRENCY_SEED as P, type TokenAgentPayments as Q, type UpdateBuybackBpsOptions as R, SHARING_CONFIG_SEED as S, TOKEN_AGENT_PAYMENTS_MIN_RENT_EXEMPT_LAMPORTS as T, type UpdateAuthorityParams as U, type UpdateBuybackBpsParams as V, type VaultBalance as W, WITHDRAW_AUTHORITY_SEED as X, type WithdrawParams as Y, createEventParser as Z, decodeGlobalConfig as _, type AcceptPaymentSimpleParams as a, decodeTokenAgentPayments as a0, getBondingCurvePDA as a1, getBuybackAuthorityPDA as a2, getGlobalConfigPDA as a3, getInvoiceIdPDA as a4, getOfflineProgram as a5, getPaymentInCurrencyPDA as a6, getProgram as a7, getPumpProgram as a8, getPumpProgramWithFallback as a9, getSharingConfigPDA as aa, getTokenAgentPaymentsPDA as ab, getWithdrawAuthorityPDA as ac, parseAgentEvents as ad, index as ae, subscribeToAgentEvents as af, index$1 as ag, type AgentAcceptPaymentEvent as b, type AgentBalances as c, type AgentBuybackTriggerEvent as d, type AgentDistributePaymentsEvent as e, type AgentEventData as f, type AgentEventName as g, type AgentInitializeEvent as h, type AgentUpdateAuthorityEvent as i, type AgentUpdateBuybackBpsEvent as j, type AgentWithdrawEvent as k, BUYBACK_AUTHORITY_SEED as l, type BuildAcceptPaymentParams as m, type BuybackTriggerParams as n, type CreateParams as o, type EventSubscriptionOptions as p, type ExtendAccountEvent as q, type ExtendAccountParams as r, type GlobalAddNewCurrencyEvent as s, type GlobalConfig as t, type GlobalConfigInitializeEvent as u, type GlobalUpdateAuthoritiesEvent as v, PROGRAM_ID as w, PUMP_AGENT_PAYMENTS_PROGRAM_ID as x, PUMP_FEES_PROGRAM_ID as y, PUMP_PROGRAM_ID as z };
