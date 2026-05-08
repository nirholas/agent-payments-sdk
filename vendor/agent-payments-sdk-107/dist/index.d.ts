import { PublicKey, AccountMeta, TransactionInstruction, Connection } from '@solana/web3.js';
import { BN, Program } from '@coral-xyz/anchor';
import BN$1 from 'bn.js';

/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/pump_agent_payments.json`.
 */
type PumpAgentPayments = {
    "address": "pUmPFn9WvfaN2WTVGnCEtJTd2ATTpvpsKRz6jVzu6u4";
    "metadata": {
        "name": "pumpAgentPayments";
        "version": "0.1.0";
        "spec": "0.1.0";
        "description": "Created with Anchor";
    };
    "instructions": [
        {
            "name": "agentAcceptPayment";
            "discriminator": [
                34,
                157,
                64,
                220,
                74,
                32,
                48,
                225
            ];
            "accounts": [
                {
                    "name": "user";
                    "writable": true;
                    "signer": true;
                },
                {
                    "name": "userTokenAccount";
                    "writable": true;
                },
                {
                    "name": "tokenAgentPayments";
                },
                {
                    "name": "tokenAgentAssociatedAccount";
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "account";
                                "path": "tokenAgentPayments";
                            },
                            {
                                "kind": "const";
                                "value": [
                                    6,
                                    221,
                                    246,
                                    225,
                                    215,
                                    101,
                                    161,
                                    147,
                                    217,
                                    203,
                                    225,
                                    70,
                                    206,
                                    235,
                                    121,
                                    172,
                                    28,
                                    180,
                                    133,
                                    237,
                                    95,
                                    91,
                                    55,
                                    145,
                                    58,
                                    140,
                                    245,
                                    133,
                                    126,
                                    255,
                                    0,
                                    169
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "currencyMint";
                            }
                        ];
                        "program": {
                            "kind": "const";
                            "value": [
                                140,
                                151,
                                37,
                                143,
                                78,
                                36,
                                137,
                                241,
                                187,
                                61,
                                16,
                                41,
                                20,
                                142,
                                13,
                                131,
                                11,
                                90,
                                19,
                                153,
                                218,
                                255,
                                16,
                                132,
                                4,
                                142,
                                123,
                                216,
                                219,
                                233,
                                248,
                                89
                            ];
                        };
                    };
                },
                {
                    "name": "tokenAgentPaymentInCurrency";
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    112,
                                    97,
                                    121,
                                    109,
                                    101,
                                    110,
                                    116,
                                    45,
                                    105,
                                    110,
                                    45,
                                    99,
                                    117,
                                    114,
                                    114,
                                    101,
                                    110,
                                    99,
                                    121
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "token_agent_payments.mint";
                                "account": "tokenAgentPayments";
                            },
                            {
                                "kind": "account";
                                "path": "currencyMint";
                            }
                        ];
                    };
                },
                {
                    "name": "globalConfig";
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    103,
                                    108,
                                    111,
                                    98,
                                    97,
                                    108,
                                    45,
                                    99,
                                    111,
                                    110,
                                    102,
                                    105,
                                    103
                                ];
                            }
                        ];
                    };
                },
                {
                    "name": "invoiceId";
                },
                {
                    "name": "currencyMint";
                },
                {
                    "name": "tokenProgram";
                },
                {
                    "name": "associatedTokenProgram";
                    "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
                },
                {
                    "name": "systemProgram";
                    "address": "11111111111111111111111111111111";
                },
                {
                    "name": "eventAuthority";
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    95,
                                    95,
                                    101,
                                    118,
                                    101,
                                    110,
                                    116,
                                    95,
                                    97,
                                    117,
                                    116,
                                    104,
                                    111,
                                    114,
                                    105,
                                    116,
                                    121
                                ];
                            }
                        ];
                    };
                },
                {
                    "name": "program";
                }
            ];
            "args": [
                {
                    "name": "amount";
                    "type": "u64";
                },
                {
                    "name": "memo";
                    "type": "u64";
                },
                {
                    "name": "startTime";
                    "type": "i64";
                },
                {
                    "name": "endTime";
                    "type": "i64";
                }
            ];
        },
        {
            "name": "agentBuybackTrigger";
            "discriminator": [
                95,
                231,
                193,
                2,
                245,
                75,
                125,
                155
            ];
            "accounts": [
                {
                    "name": "globalBuybackAuthority";
                    "writable": true;
                    "signer": true;
                },
                {
                    "name": "mint";
                    "writable": true;
                },
                {
                    "name": "tokenAgentPayments";
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    116,
                                    111,
                                    107,
                                    101,
                                    110,
                                    45,
                                    97,
                                    103,
                                    101,
                                    110,
                                    116,
                                    45,
                                    112,
                                    97,
                                    121,
                                    109,
                                    101,
                                    110,
                                    116,
                                    115
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "mint";
                            }
                        ];
                    };
                },
                {
                    "name": "tokenAgentPaymentInCurrency";
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    112,
                                    97,
                                    121,
                                    109,
                                    101,
                                    110,
                                    116,
                                    45,
                                    105,
                                    110,
                                    45,
                                    99,
                                    117,
                                    114,
                                    114,
                                    101,
                                    110,
                                    99,
                                    121
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "token_agent_payments.mint";
                                "account": "tokenAgentPayments";
                            },
                            {
                                "kind": "account";
                                "path": "currencyMint";
                            }
                        ];
                    };
                },
                {
                    "name": "currencyMint";
                },
                {
                    "name": "globalConfig";
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    103,
                                    108,
                                    111,
                                    98,
                                    97,
                                    108,
                                    45,
                                    99,
                                    111,
                                    110,
                                    102,
                                    105,
                                    103
                                ];
                            }
                        ];
                    };
                },
                {
                    "name": "swapProgramToInvoke";
                },
                {
                    "name": "burnAuthority";
                    "docs": [
                        "Intentionally called burn_authority",
                        "TO avoid any confusion with the global buyback authority."
                    ];
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    98,
                                    117,
                                    121,
                                    98,
                                    97,
                                    99,
                                    107,
                                    45,
                                    97,
                                    117,
                                    116,
                                    104,
                                    111,
                                    114,
                                    105,
                                    116,
                                    121
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "token_agent_payments.mint";
                                "account": "tokenAgentPayments";
                            }
                        ];
                    };
                },
                {
                    "name": "burnMintVault";
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "account";
                                "path": "burnAuthority";
                            },
                            {
                                "kind": "const";
                                "value": [
                                    6,
                                    221,
                                    246,
                                    225,
                                    215,
                                    101,
                                    161,
                                    147,
                                    217,
                                    203,
                                    225,
                                    70,
                                    206,
                                    235,
                                    121,
                                    172,
                                    28,
                                    180,
                                    133,
                                    237,
                                    95,
                                    91,
                                    55,
                                    145,
                                    58,
                                    140,
                                    245,
                                    133,
                                    126,
                                    255,
                                    0,
                                    169
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "mint";
                            }
                        ];
                        "program": {
                            "kind": "const";
                            "value": [
                                140,
                                151,
                                37,
                                143,
                                78,
                                36,
                                137,
                                241,
                                187,
                                61,
                                16,
                                41,
                                20,
                                142,
                                13,
                                131,
                                11,
                                90,
                                19,
                                153,
                                218,
                                255,
                                16,
                                132,
                                4,
                                142,
                                123,
                                216,
                                219,
                                233,
                                248,
                                89
                            ];
                        };
                    };
                },
                {
                    "name": "tokenProgram";
                },
                {
                    "name": "associatedTokenProgram";
                    "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
                },
                {
                    "name": "systemProgram";
                    "address": "11111111111111111111111111111111";
                },
                {
                    "name": "eventAuthority";
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    95,
                                    95,
                                    101,
                                    118,
                                    101,
                                    110,
                                    116,
                                    95,
                                    97,
                                    117,
                                    116,
                                    104,
                                    111,
                                    114,
                                    105,
                                    116,
                                    121
                                ];
                            }
                        ];
                    };
                },
                {
                    "name": "program";
                }
            ];
            "args": [
                {
                    "name": "swapInstructionData";
                    "type": "bytes";
                }
            ];
        },
        {
            "name": "agentDistributePayments";
            "discriminator": [
                145,
                44,
                246,
                47,
                192,
                204,
                95,
                32
            ];
            "accounts": [
                {
                    "name": "user";
                    "writable": true;
                    "signer": true;
                },
                {
                    "name": "globalConfig";
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    103,
                                    108,
                                    111,
                                    98,
                                    97,
                                    108,
                                    45,
                                    99,
                                    111,
                                    110,
                                    102,
                                    105,
                                    103
                                ];
                            }
                        ];
                    };
                },
                {
                    "name": "currencyMint";
                },
                {
                    "name": "tokenAgentPayments";
                },
                {
                    "name": "tokenAgentPaymentInCurrency";
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    112,
                                    97,
                                    121,
                                    109,
                                    101,
                                    110,
                                    116,
                                    45,
                                    105,
                                    110,
                                    45,
                                    99,
                                    117,
                                    114,
                                    114,
                                    101,
                                    110,
                                    99,
                                    121
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "token_agent_payments.mint";
                                "account": "tokenAgentPayments";
                            },
                            {
                                "kind": "account";
                                "path": "currencyMint";
                            }
                        ];
                    };
                },
                {
                    "name": "tokenAgentAssociatedAccount";
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "account";
                                "path": "tokenAgentPayments";
                            },
                            {
                                "kind": "const";
                                "value": [
                                    6,
                                    221,
                                    246,
                                    225,
                                    215,
                                    101,
                                    161,
                                    147,
                                    217,
                                    203,
                                    225,
                                    70,
                                    206,
                                    235,
                                    121,
                                    172,
                                    28,
                                    180,
                                    133,
                                    237,
                                    95,
                                    91,
                                    55,
                                    145,
                                    58,
                                    140,
                                    245,
                                    133,
                                    126,
                                    255,
                                    0,
                                    169
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "currencyMint";
                            }
                        ];
                        "program": {
                            "kind": "const";
                            "value": [
                                140,
                                151,
                                37,
                                143,
                                78,
                                36,
                                137,
                                241,
                                187,
                                61,
                                16,
                                41,
                                20,
                                142,
                                13,
                                131,
                                11,
                                90,
                                19,
                                153,
                                218,
                                255,
                                16,
                                132,
                                4,
                                142,
                                123,
                                216,
                                219,
                                233,
                                248,
                                89
                            ];
                        };
                    };
                },
                {
                    "name": "buybackAuthority";
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    98,
                                    117,
                                    121,
                                    98,
                                    97,
                                    99,
                                    107,
                                    45,
                                    97,
                                    117,
                                    116,
                                    104,
                                    111,
                                    114,
                                    105,
                                    116,
                                    121
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "token_agent_payments.mint";
                                "account": "tokenAgentPayments";
                            }
                        ];
                    };
                },
                {
                    "name": "withdrawAuthority";
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    119,
                                    105,
                                    116,
                                    104,
                                    100,
                                    114,
                                    97,
                                    119,
                                    45,
                                    97,
                                    117,
                                    116,
                                    104,
                                    111,
                                    114,
                                    105,
                                    116,
                                    121
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "token_agent_payments.mint";
                                "account": "tokenAgentPayments";
                            }
                        ];
                    };
                },
                {
                    "name": "buybackVault";
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "account";
                                "path": "buybackAuthority";
                            },
                            {
                                "kind": "const";
                                "value": [
                                    6,
                                    221,
                                    246,
                                    225,
                                    215,
                                    101,
                                    161,
                                    147,
                                    217,
                                    203,
                                    225,
                                    70,
                                    206,
                                    235,
                                    121,
                                    172,
                                    28,
                                    180,
                                    133,
                                    237,
                                    95,
                                    91,
                                    55,
                                    145,
                                    58,
                                    140,
                                    245,
                                    133,
                                    126,
                                    255,
                                    0,
                                    169
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "currencyMint";
                            }
                        ];
                        "program": {
                            "kind": "const";
                            "value": [
                                140,
                                151,
                                37,
                                143,
                                78,
                                36,
                                137,
                                241,
                                187,
                                61,
                                16,
                                41,
                                20,
                                142,
                                13,
                                131,
                                11,
                                90,
                                19,
                                153,
                                218,
                                255,
                                16,
                                132,
                                4,
                                142,
                                123,
                                216,
                                219,
                                233,
                                248,
                                89
                            ];
                        };
                    };
                },
                {
                    "name": "withdrawVault";
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "account";
                                "path": "withdrawAuthority";
                            },
                            {
                                "kind": "const";
                                "value": [
                                    6,
                                    221,
                                    246,
                                    225,
                                    215,
                                    101,
                                    161,
                                    147,
                                    217,
                                    203,
                                    225,
                                    70,
                                    206,
                                    235,
                                    121,
                                    172,
                                    28,
                                    180,
                                    133,
                                    237,
                                    95,
                                    91,
                                    55,
                                    145,
                                    58,
                                    140,
                                    245,
                                    133,
                                    126,
                                    255,
                                    0,
                                    169
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "currencyMint";
                            }
                        ];
                        "program": {
                            "kind": "const";
                            "value": [
                                140,
                                151,
                                37,
                                143,
                                78,
                                36,
                                137,
                                241,
                                187,
                                61,
                                16,
                                41,
                                20,
                                142,
                                13,
                                131,
                                11,
                                90,
                                19,
                                153,
                                218,
                                255,
                                16,
                                132,
                                4,
                                142,
                                123,
                                216,
                                219,
                                233,
                                248,
                                89
                            ];
                        };
                    };
                },
                {
                    "name": "tokenProgram";
                },
                {
                    "name": "associatedTokenProgram";
                    "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
                },
                {
                    "name": "systemProgram";
                    "address": "11111111111111111111111111111111";
                },
                {
                    "name": "eventAuthority";
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    95,
                                    95,
                                    101,
                                    118,
                                    101,
                                    110,
                                    116,
                                    95,
                                    97,
                                    117,
                                    116,
                                    104,
                                    111,
                                    114,
                                    105,
                                    116,
                                    121
                                ];
                            }
                        ];
                    };
                },
                {
                    "name": "program";
                }
            ];
            "args": [];
        },
        {
            "name": "agentInitialize";
            "discriminator": [
                180,
                248,
                163,
                8,
                49,
                94,
                126,
                96
            ];
            "accounts": [
                {
                    "name": "authority";
                    "writable": true;
                    "signer": true;
                },
                {
                    "name": "bondingCurve";
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    98,
                                    111,
                                    110,
                                    100,
                                    105,
                                    110,
                                    103,
                                    45,
                                    99,
                                    117,
                                    114,
                                    118,
                                    101
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "mint";
                            }
                        ];
                        "program": {
                            "kind": "const";
                            "value": [
                                1,
                                86,
                                224,
                                246,
                                147,
                                102,
                                90,
                                207,
                                68,
                                219,
                                21,
                                104,
                                191,
                                23,
                                91,
                                170,
                                81,
                                137,
                                203,
                                151,
                                245,
                                210,
                                255,
                                59,
                                101,
                                93,
                                43,
                                182,
                                253,
                                109,
                                24,
                                176
                            ];
                        };
                    };
                },
                {
                    "name": "globalConfig";
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    103,
                                    108,
                                    111,
                                    98,
                                    97,
                                    108,
                                    45,
                                    99,
                                    111,
                                    110,
                                    102,
                                    105,
                                    103
                                ];
                            }
                        ];
                    };
                },
                {
                    "name": "mint";
                },
                {
                    "name": "tokenAgentPayments";
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    116,
                                    111,
                                    107,
                                    101,
                                    110,
                                    45,
                                    97,
                                    103,
                                    101,
                                    110,
                                    116,
                                    45,
                                    112,
                                    97,
                                    121,
                                    109,
                                    101,
                                    110,
                                    116,
                                    115
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "mint";
                            }
                        ];
                    };
                },
                {
                    "name": "systemProgram";
                    "address": "11111111111111111111111111111111";
                },
                {
                    "name": "eventAuthority";
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    95,
                                    95,
                                    101,
                                    118,
                                    101,
                                    110,
                                    116,
                                    95,
                                    97,
                                    117,
                                    116,
                                    104,
                                    111,
                                    114,
                                    105,
                                    116,
                                    121
                                ];
                            }
                        ];
                    };
                },
                {
                    "name": "program";
                }
            ];
            "args": [
                {
                    "name": "authority";
                    "type": "pubkey";
                },
                {
                    "name": "buybackBps";
                    "type": "u16";
                }
            ];
        },
        {
            "name": "agentUpdateAuthority";
            "discriminator": [
                237,
                228,
                227,
                224,
                226,
                198,
                167,
                83
            ];
            "accounts": [
                {
                    "name": "authority";
                    "writable": true;
                    "signer": true;
                },
                {
                    "name": "globalConfig";
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    103,
                                    108,
                                    111,
                                    98,
                                    97,
                                    108,
                                    45,
                                    99,
                                    111,
                                    110,
                                    102,
                                    105,
                                    103
                                ];
                            }
                        ];
                    };
                },
                {
                    "name": "tokenAgentPayments";
                    "writable": true;
                },
                {
                    "name": "systemProgram";
                    "address": "11111111111111111111111111111111";
                },
                {
                    "name": "eventAuthority";
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    95,
                                    95,
                                    101,
                                    118,
                                    101,
                                    110,
                                    116,
                                    95,
                                    97,
                                    117,
                                    116,
                                    104,
                                    111,
                                    114,
                                    105,
                                    116,
                                    121
                                ];
                            }
                        ];
                    };
                },
                {
                    "name": "program";
                }
            ];
            "args": [
                {
                    "name": "newAuthority";
                    "type": "pubkey";
                }
            ];
        },
        {
            "name": "agentUpdateBuybackBps";
            "discriminator": [
                41,
                28,
                118,
                90,
                53,
                24,
                63,
                160
            ];
            "accounts": [
                {
                    "name": "authority";
                    "writable": true;
                    "signer": true;
                },
                {
                    "name": "tokenAgentPayments";
                    "writable": true;
                },
                {
                    "name": "globalConfig";
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    103,
                                    108,
                                    111,
                                    98,
                                    97,
                                    108,
                                    45,
                                    99,
                                    111,
                                    110,
                                    102,
                                    105,
                                    103
                                ];
                            }
                        ];
                    };
                },
                {
                    "name": "eventAuthority";
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    95,
                                    95,
                                    101,
                                    118,
                                    101,
                                    110,
                                    116,
                                    95,
                                    97,
                                    117,
                                    116,
                                    104,
                                    111,
                                    114,
                                    105,
                                    116,
                                    121
                                ];
                            }
                        ];
                    };
                },
                {
                    "name": "program";
                }
            ];
            "args": [
                {
                    "name": "buybackBps";
                    "type": "u16";
                }
            ];
        },
        {
            "name": "agentWithdraw";
            "discriminator": [
                13,
                149,
                99,
                245,
                171,
                171,
                185,
                53
            ];
            "accounts": [
                {
                    "name": "authority";
                    "writable": true;
                    "signer": true;
                },
                {
                    "name": "tokenAgentPayments";
                },
                {
                    "name": "currencyMint";
                },
                {
                    "name": "withdrawAuthority";
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    119,
                                    105,
                                    116,
                                    104,
                                    100,
                                    114,
                                    97,
                                    119,
                                    45,
                                    97,
                                    117,
                                    116,
                                    104,
                                    111,
                                    114,
                                    105,
                                    116,
                                    121
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "token_agent_payments.mint";
                                "account": "tokenAgentPayments";
                            }
                        ];
                    };
                },
                {
                    "name": "withdrawVault";
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "account";
                                "path": "withdrawAuthority";
                            },
                            {
                                "kind": "const";
                                "value": [
                                    6,
                                    221,
                                    246,
                                    225,
                                    215,
                                    101,
                                    161,
                                    147,
                                    217,
                                    203,
                                    225,
                                    70,
                                    206,
                                    235,
                                    121,
                                    172,
                                    28,
                                    180,
                                    133,
                                    237,
                                    95,
                                    91,
                                    55,
                                    145,
                                    58,
                                    140,
                                    245,
                                    133,
                                    126,
                                    255,
                                    0,
                                    169
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "currencyMint";
                            }
                        ];
                        "program": {
                            "kind": "const";
                            "value": [
                                140,
                                151,
                                37,
                                143,
                                78,
                                36,
                                137,
                                241,
                                187,
                                61,
                                16,
                                41,
                                20,
                                142,
                                13,
                                131,
                                11,
                                90,
                                19,
                                153,
                                218,
                                255,
                                16,
                                132,
                                4,
                                142,
                                123,
                                216,
                                219,
                                233,
                                248,
                                89
                            ];
                        };
                    };
                },
                {
                    "name": "receiverAta";
                    "writable": true;
                },
                {
                    "name": "tokenProgram";
                },
                {
                    "name": "associatedTokenProgram";
                    "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
                },
                {
                    "name": "systemProgram";
                    "address": "11111111111111111111111111111111";
                },
                {
                    "name": "eventAuthority";
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    95,
                                    95,
                                    101,
                                    118,
                                    101,
                                    110,
                                    116,
                                    95,
                                    97,
                                    117,
                                    116,
                                    104,
                                    111,
                                    114,
                                    105,
                                    116,
                                    121
                                ];
                            }
                        ];
                    };
                },
                {
                    "name": "program";
                }
            ];
            "args": [];
        },
        {
            "name": "closeAccount";
            "discriminator": [
                125,
                255,
                149,
                14,
                110,
                34,
                72,
                24
            ];
            "accounts": [
                {
                    "name": "account";
                    "writable": true;
                },
                {
                    "name": "user";
                    "writable": true;
                    "signer": true;
                },
                {
                    "name": "globalConfig";
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    103,
                                    108,
                                    111,
                                    98,
                                    97,
                                    108,
                                    45,
                                    99,
                                    111,
                                    110,
                                    102,
                                    105,
                                    103
                                ];
                            }
                        ];
                    };
                },
                {
                    "name": "systemProgram";
                    "address": "11111111111111111111111111111111";
                }
            ];
            "args": [];
        },
        {
            "name": "extendAccount";
            "discriminator": [
                234,
                102,
                194,
                203,
                150,
                72,
                62,
                229
            ];
            "accounts": [
                {
                    "name": "account";
                    "writable": true;
                },
                {
                    "name": "user";
                    "writable": true;
                    "signer": true;
                },
                {
                    "name": "systemProgram";
                    "address": "11111111111111111111111111111111";
                },
                {
                    "name": "eventAuthority";
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    95,
                                    95,
                                    101,
                                    118,
                                    101,
                                    110,
                                    116,
                                    95,
                                    97,
                                    117,
                                    116,
                                    104,
                                    111,
                                    114,
                                    105,
                                    116,
                                    121
                                ];
                            }
                        ];
                    };
                },
                {
                    "name": "program";
                }
            ];
            "args": [];
        },
        {
            "name": "globalAddNewCurrency";
            "discriminator": [
                46,
                135,
                47,
                120,
                118,
                204,
                177,
                224
            ];
            "accounts": [
                {
                    "name": "authority";
                    "writable": true;
                    "signer": true;
                },
                {
                    "name": "globalConfig";
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    103,
                                    108,
                                    111,
                                    98,
                                    97,
                                    108,
                                    45,
                                    99,
                                    111,
                                    110,
                                    102,
                                    105,
                                    103
                                ];
                            }
                        ];
                    };
                },
                {
                    "name": "mint";
                },
                {
                    "name": "eventAuthority";
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    95,
                                    95,
                                    101,
                                    118,
                                    101,
                                    110,
                                    116,
                                    95,
                                    97,
                                    117,
                                    116,
                                    104,
                                    111,
                                    114,
                                    105,
                                    116,
                                    121
                                ];
                            }
                        ];
                    };
                },
                {
                    "name": "program";
                }
            ];
            "args": [];
        },
        {
            "name": "globalConfigInitialize";
            "discriminator": [
                61,
                23,
                208,
                192,
                232,
                52,
                8,
                66
            ];
            "accounts": [
                {
                    "name": "authority";
                    "writable": true;
                    "signer": true;
                },
                {
                    "name": "globalConfig";
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    103,
                                    108,
                                    111,
                                    98,
                                    97,
                                    108,
                                    45,
                                    99,
                                    111,
                                    110,
                                    102,
                                    105,
                                    103
                                ];
                            }
                        ];
                    };
                },
                {
                    "name": "systemProgram";
                    "address": "11111111111111111111111111111111";
                },
                {
                    "name": "eventAuthority";
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    95,
                                    95,
                                    101,
                                    118,
                                    101,
                                    110,
                                    116,
                                    95,
                                    97,
                                    117,
                                    116,
                                    104,
                                    111,
                                    114,
                                    105,
                                    116,
                                    121
                                ];
                            }
                        ];
                    };
                },
                {
                    "name": "program";
                }
            ];
            "args": [
                {
                    "name": "protocolAuthority";
                    "type": "pubkey";
                },
                {
                    "name": "buybackAuthority";
                    "type": "pubkey";
                }
            ];
        },
        {
            "name": "globalUpdateAuthorities";
            "discriminator": [
                91,
                137,
                72,
                77,
                183,
                184,
                168,
                125
            ];
            "accounts": [
                {
                    "name": "authority";
                    "writable": true;
                    "signer": true;
                },
                {
                    "name": "globalConfig";
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    103,
                                    108,
                                    111,
                                    98,
                                    97,
                                    108,
                                    45,
                                    99,
                                    111,
                                    110,
                                    102,
                                    105,
                                    103
                                ];
                            }
                        ];
                    };
                },
                {
                    "name": "eventAuthority";
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    95,
                                    95,
                                    101,
                                    118,
                                    101,
                                    110,
                                    116,
                                    95,
                                    97,
                                    117,
                                    116,
                                    104,
                                    111,
                                    114,
                                    105,
                                    116,
                                    121
                                ];
                            }
                        ];
                    };
                },
                {
                    "name": "program";
                }
            ];
            "args": [
                {
                    "name": "protocolAuthority";
                    "type": {
                        "option": "pubkey";
                    };
                },
                {
                    "name": "buybackAuthority";
                    "type": {
                        "option": "pubkey";
                    };
                }
            ];
        }
    ];
    "accounts": [
        {
            "name": "bondingCurve";
            "discriminator": [
                23,
                183,
                248,
                55,
                96,
                216,
                172,
                96
            ];
        },
        {
            "name": "globalConfig";
            "discriminator": [
                149,
                8,
                156,
                202,
                160,
                252,
                176,
                217
            ];
        },
        {
            "name": "tokenAgentPaymentInCurrency";
            "discriminator": [
                225,
                195,
                81,
                227,
                115,
                43,
                25,
                177
            ];
        },
        {
            "name": "tokenAgentPayments";
            "discriminator": [
                136,
                241,
                242,
                217,
                173,
                77,
                112,
                186
            ];
        }
    ];
    "events": [
        {
            "name": "agentAcceptPaymentEvent";
            "discriminator": [
                114,
                190,
                188,
                192,
                105,
                79,
                41,
                147
            ];
        },
        {
            "name": "agentBuybackTriggerEvent";
            "discriminator": [
                139,
                240,
                9,
                225,
                214,
                63,
                232,
                165
            ];
        },
        {
            "name": "agentDistributePaymentsEvent";
            "discriminator": [
                137,
                116,
                114,
                140,
                54,
                111,
                230,
                26
            ];
        },
        {
            "name": "agentInitializeEvent";
            "discriminator": [
                192,
                5,
                183,
                151,
                0,
                64,
                100,
                207
            ];
        },
        {
            "name": "agentUpdateAuthorityEvent";
            "discriminator": [
                36,
                212,
                117,
                235,
                74,
                166,
                60,
                16
            ];
        },
        {
            "name": "agentUpdateBuybackBpsEvent";
            "discriminator": [
                165,
                251,
                40,
                19,
                114,
                26,
                128,
                232
            ];
        },
        {
            "name": "agentWithdrawEvent";
            "discriminator": [
                174,
                231,
                201,
                69,
                254,
                183,
                49,
                85
            ];
        },
        {
            "name": "extendAccountEvent";
            "discriminator": [
                97,
                97,
                215,
                144,
                93,
                146,
                22,
                124
            ];
        },
        {
            "name": "globalAddNewCurrencyEvent";
            "discriminator": [
                130,
                202,
                37,
                248,
                241,
                182,
                233,
                35
            ];
        },
        {
            "name": "globalConfigInitializeEvent";
            "discriminator": [
                241,
                51,
                222,
                190,
                142,
                245,
                176,
                53
            ];
        },
        {
            "name": "globalUpdateAuthoritiesEvent";
            "discriminator": [
                82,
                27,
                22,
                232,
                53,
                66,
                35,
                207
            ];
        }
    ];
    "errors": [
        {
            "code": 6000;
            "name": "unauthorizedSigner";
            "msg": "The given account is not authorized to execute this instruction.";
        },
        {
            "code": 6001;
            "name": "currencyAlreadySupported";
            "msg": "The given currency is already supported.";
        },
        {
            "code": 6002;
            "name": "maxCurrenciesReached";
            "msg": "The maximum number of currencies has been reached.";
        },
        {
            "code": 6003;
            "name": "invalidBuybackBps";
            "msg": "The buyback basis points is greater than 10000.";
        },
        {
            "code": 6004;
            "name": "currencyNotSupported";
            "msg": "The given currency is not supported.";
        },
        {
            "code": 6005;
            "name": "mathOverflow";
            "msg": "Math overflow.";
        },
        {
            "code": 6006;
            "name": "invalidRemainingAccountAddress";
            "msg": "The given remaining account address is invalid.";
        },
        {
            "code": 6007;
            "name": "paymentVaultNotEmpty";
            "msg": "The payment vault is not empty. Distribute the payments first.";
        },
        {
            "code": 6008;
            "name": "invalidInvoiceAccount";
            "msg": "The invoice account does not match the expected PDA seeds";
        },
        {
            "code": 6009;
            "name": "invalidProgramToInvoke";
            "msg": "The program to invoke is not allowed.";
        },
        {
            "code": 6010;
            "name": "invalidCallbackProgram";
            "msg": "The callback program is invalid.";
        },
        {
            "code": 6011;
            "name": "swapFailedAmountDidNotIncrease";
            "msg": "The swap failed and the amount did not increase.";
        },
        {
            "code": 6012;
            "name": "accountTypeNotSupported";
            "msg": "The account type is not supported for extension.";
        }
    ];
    "types": [
        {
            "name": "agentAcceptPaymentEvent";
            "type": {
                "kind": "struct";
                "fields": [
                    {
                        "name": "user";
                        "type": "pubkey";
                    },
                    {
                        "name": "tokenizedAgentMint";
                        "type": "pubkey";
                    },
                    {
                        "name": "tokenAgentPayments";
                        "type": "pubkey";
                    },
                    {
                        "name": "currencyMint";
                        "type": "pubkey";
                    },
                    {
                        "name": "amount";
                        "type": "u64";
                    },
                    {
                        "name": "memo";
                        "type": "u64";
                    },
                    {
                        "name": "startTime";
                        "type": "i64";
                    },
                    {
                        "name": "endTime";
                        "type": "i64";
                    },
                    {
                        "name": "invoiceId";
                        "type": "pubkey";
                    },
                    {
                        "name": "agentPostBalance";
                        "type": "u64";
                    },
                    {
                        "name": "timestamp";
                        "type": "i64";
                    }
                ];
            };
        },
        {
            "name": "agentBuybackTriggerEvent";
            "type": {
                "kind": "struct";
                "fields": [
                    {
                        "name": "tokenAgentPayments";
                        "type": "pubkey";
                    },
                    {
                        "name": "mint";
                        "type": "pubkey";
                    },
                    {
                        "name": "amountBurned";
                        "type": "u64";
                    },
                    {
                        "name": "swapProgram";
                        "type": "pubkey";
                    },
                    {
                        "name": "newTokensBoughtAndBurnedForCurrency";
                        "type": "u64";
                    },
                    {
                        "name": "timestamp";
                        "type": "i64";
                    }
                ];
            };
        },
        {
            "name": "agentDistributePaymentsEvent";
            "type": {
                "kind": "struct";
                "fields": [
                    {
                        "name": "tokenAgentPayments";
                        "type": "pubkey";
                    },
                    {
                        "name": "currencyMint";
                        "type": "pubkey";
                    },
                    {
                        "name": "buybackBps";
                        "type": "u16";
                    },
                    {
                        "name": "buybackAmount";
                        "type": "u64";
                    },
                    {
                        "name": "withdrawAmount";
                        "type": "u64";
                    },
                    {
                        "name": "timestamp";
                        "type": "i64";
                    }
                ];
            };
        },
        {
            "name": "agentInitializeEvent";
            "type": {
                "kind": "struct";
                "fields": [
                    {
                        "name": "tokenAgentPayments";
                        "type": "pubkey";
                    },
                    {
                        "name": "mint";
                        "type": "pubkey";
                    },
                    {
                        "name": "authority";
                        "type": "pubkey";
                    },
                    {
                        "name": "buybackBps";
                        "type": "u16";
                    },
                    {
                        "name": "timestamp";
                        "type": "i64";
                    },
                    {
                        "name": "tokenizedAgentSequence";
                        "type": "u64";
                    }
                ];
            };
        },
        {
            "name": "agentUpdateAuthorityEvent";
            "type": {
                "kind": "struct";
                "fields": [
                    {
                        "name": "tokenAgentPayments";
                        "type": "pubkey";
                    },
                    {
                        "name": "oldAuthority";
                        "type": "pubkey";
                    },
                    {
                        "name": "newAuthority";
                        "type": "pubkey";
                    },
                    {
                        "name": "timestamp";
                        "type": "i64";
                    }
                ];
            };
        },
        {
            "name": "agentUpdateBuybackBpsEvent";
            "type": {
                "kind": "struct";
                "fields": [
                    {
                        "name": "tokenAgentPayments";
                        "type": "pubkey";
                    },
                    {
                        "name": "mint";
                        "type": "pubkey";
                    },
                    {
                        "name": "oldBuybackBps";
                        "type": "u16";
                    },
                    {
                        "name": "newBuybackBps";
                        "type": "u16";
                    },
                    {
                        "name": "timestamp";
                        "type": "i64";
                    }
                ];
            };
        },
        {
            "name": "agentWithdrawEvent";
            "type": {
                "kind": "struct";
                "fields": [
                    {
                        "name": "tokenAgentPayments";
                        "type": "pubkey";
                    },
                    {
                        "name": "currencyMint";
                        "type": "pubkey";
                    },
                    {
                        "name": "amount";
                        "type": "u64";
                    },
                    {
                        "name": "receiver";
                        "type": "pubkey";
                    },
                    {
                        "name": "timestamp";
                        "type": "i64";
                    }
                ];
            };
        },
        {
            "name": "bondingCurve";
            "type": {
                "kind": "struct";
                "fields": [
                    {
                        "name": "virtualTokenReserves";
                        "type": "u64";
                    },
                    {
                        "name": "virtualSolReserves";
                        "type": "u64";
                    },
                    {
                        "name": "realTokenReserves";
                        "type": "u64";
                    },
                    {
                        "name": "realSolReserves";
                        "type": "u64";
                    },
                    {
                        "name": "tokenTotalSupply";
                        "type": "u64";
                    },
                    {
                        "name": "complete";
                        "type": "bool";
                    },
                    {
                        "name": "creator";
                        "type": "pubkey";
                    },
                    {
                        "name": "isMayhemMode";
                        "type": "bool";
                    }
                ];
            };
        },
        {
            "name": "extendAccountEvent";
            "type": {
                "kind": "struct";
                "fields": [
                    {
                        "name": "account";
                        "type": "pubkey";
                    },
                    {
                        "name": "user";
                        "type": "pubkey";
                    },
                    {
                        "name": "currentSize";
                        "type": "u64";
                    },
                    {
                        "name": "newSize";
                        "type": "u64";
                    },
                    {
                        "name": "timestamp";
                        "type": "i64";
                    }
                ];
            };
        },
        {
            "name": "globalAddNewCurrencyEvent";
            "type": {
                "kind": "struct";
                "fields": [
                    {
                        "name": "globalConfig";
                        "type": "pubkey";
                    },
                    {
                        "name": "currencyMint";
                        "type": "pubkey";
                    },
                    {
                        "name": "timestamp";
                        "type": "i64";
                    }
                ];
            };
        },
        {
            "name": "globalConfig";
            "type": {
                "kind": "struct";
                "fields": [
                    {
                        "name": "bump";
                        "type": "u8";
                    },
                    {
                        "name": "protocolAuthority";
                        "type": "pubkey";
                    },
                    {
                        "name": "buybackAuthority";
                        "type": "pubkey";
                    },
                    {
                        "name": "supportedCurrenciesMint";
                        "type": {
                            "array": [
                                "pubkey",
                                10
                            ];
                        };
                    },
                    {
                        "name": "tokenizedAgentSequence";
                        "type": "u64";
                    }
                ];
            };
        },
        {
            "name": "globalConfigInitializeEvent";
            "type": {
                "kind": "struct";
                "fields": [
                    {
                        "name": "globalConfig";
                        "type": "pubkey";
                    },
                    {
                        "name": "protocolAuthority";
                        "type": "pubkey";
                    },
                    {
                        "name": "buybackAuthority";
                        "type": "pubkey";
                    },
                    {
                        "name": "timestamp";
                        "type": "i64";
                    }
                ];
            };
        },
        {
            "name": "globalUpdateAuthoritiesEvent";
            "type": {
                "kind": "struct";
                "fields": [
                    {
                        "name": "globalConfig";
                        "type": "pubkey";
                    },
                    {
                        "name": "protocolAuthority";
                        "type": {
                            "option": "pubkey";
                        };
                    },
                    {
                        "name": "buybackAuthority";
                        "type": {
                            "option": "pubkey";
                        };
                    },
                    {
                        "name": "timestamp";
                        "type": "i64";
                    }
                ];
            };
        },
        {
            "name": "tokenAgentPaymentInCurrency";
            "type": {
                "kind": "struct";
                "fields": [
                    {
                        "name": "mint";
                        "type": "pubkey";
                    },
                    {
                        "name": "currencyMint";
                        "type": "pubkey";
                    },
                    {
                        "name": "totalInvoicePaymentsMade";
                        "type": "u64";
                    },
                    {
                        "name": "totalBuyback";
                        "type": "u64";
                    },
                    {
                        "name": "totalWithdrawals";
                        "type": "u64";
                    },
                    {
                        "name": "tokensBoughtBackAndBurned";
                        "type": "u64";
                    }
                ];
            };
        },
        {
            "name": "tokenAgentPayments";
            "type": {
                "kind": "struct";
                "fields": [
                    {
                        "name": "bump";
                        "type": "u8";
                    },
                    {
                        "name": "mint";
                        "type": "pubkey";
                    },
                    {
                        "name": "authority";
                        "type": "pubkey";
                    },
                    {
                        "name": "buybackBps";
                        "type": "u16";
                    }
                ];
            };
        }
    ];
};

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
    /** Optional pre-fetched supported currencies to avoid network fetch. */
    supportedCurrenciesMint?: PublicKey[];
}
interface AcceptPaymentParams {
    /** Payer / user signer */
    user: PublicKey;
    /** User's token account holding the currency */
    userTokenAccount: PublicKey;
    /** The currency mint being paid */
    currencyMint: PublicKey;
    amount: BN;
    memo: BN;
    startTime: BN;
    endTime: BN;
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
}
interface DistributePaymentsParams {
    /** Any signer (permissionless) */
    user: PublicKey;
    /** Currency mint to distribute */
    currencyMint: PublicKey;
    /** Token program for the currency mint (defaults to TOKEN_PROGRAM_ID) */
    tokenProgram?: PublicKey;
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

declare class PumpAgentOffline {
    readonly mint: PublicKey;
    protected readonly program: Program<PumpAgentPayments>;
    constructor(mint: PublicKey, program?: Program<PumpAgentPayments>);
    create(params: CreateParams): Promise<TransactionInstruction>;
    static load(mint: PublicKey, connection?: Connection): PumpAgentOffline;
    withdraw(params: WithdrawParams): Promise<TransactionInstruction>;
    updateBuybackBps(params: UpdateBuybackBpsParams, options?: UpdateBuybackBpsOptions): Promise<TransactionInstruction>;
    acceptPayment(params: AcceptPaymentParams): Promise<TransactionInstruction>;
    acceptPaymentSimple(params: AcceptPaymentSimpleParams): Promise<TransactionInstruction>;
    distributePayments(params: DistributePaymentsParams): Promise<TransactionInstruction>;
    buybackTrigger(params: BuybackTriggerParams): Promise<TransactionInstruction>;
    extendAccount(params: ExtendAccountParams): Promise<TransactionInstruction>;
    updateAuthority(params: UpdateAuthorityParams): Promise<TransactionInstruction>;
}

declare class PumpAgent extends PumpAgentOffline {
    private connection;
    constructor(mint: PublicKey, connection: Connection);
    /**
     * Fetches the current balances for all three vaults for a given currency.
     * Returns the vault address and its token balance.
     * If a vault ATA does not exist yet the balance is reported as 0n.
     */
    getBalances(currencyMint: PublicKey): Promise<AgentBalances>;
    /**
     * Returns the `agent_update_buyback_bps` instruction and auto-fetches
     * supported currencies from GlobalConfig when options are omitted.
     */
    updateBuybackBps(params: UpdateBuybackBpsParams, options?: UpdateBuybackBpsOptions): Promise<TransactionInstruction>;
}

declare function getPumpProgram(connection: Connection): Program<PumpAgentPayments>;
declare const OFFLINE_PUMP_PROGRAM: Program<PumpAgentPayments>;
declare function getPumpProgramWithFallback(connection?: Connection): Program<PumpAgentPayments>;
declare function getOfflineProgram(): Program<PumpAgentPayments>;

/** Pump Agent Payments program ID */
declare const PROGRAM_ID: PublicKey;
/** Pump (bonding curve) program ID */
declare const PUMP_PROGRAM_ID: PublicKey;
declare const GLOBAL_CONFIG_SEED: Buffer;
declare const TOKEN_AGENT_PAYMENTS_SEED: Buffer;
declare const PAYMENT_IN_CURRENCY_SEED: Buffer;
declare const INVOICE_ID_SEED: Buffer;
declare const BUYBACK_AUTHORITY_SEED: Buffer;
declare const WITHDRAW_AUTHORITY_SEED: Buffer;
declare const BONDING_CURVE_SEED: Buffer;

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
declare function getInvoiceIdPDA(tokenMint: PublicKey, currencyMint: PublicKey, amount: BN$1, memo: BN$1, startTime: BN$1, endTime: BN$1): [PublicKey, number];
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

type GlobalConfig = Awaited<ReturnType<typeof OFFLINE_PUMP_PROGRAM.account.globalConfig.fetch>>;
type TokenAgentPaymentInCurrency = Awaited<ReturnType<typeof OFFLINE_PUMP_PROGRAM.account.tokenAgentPaymentInCurrency.fetch>>;
type TokenAgentPayments = Awaited<ReturnType<typeof OFFLINE_PUMP_PROGRAM.account.tokenAgentPayments.fetch>>;
declare function decodeGlobalConfig(accountData: Buffer): GlobalConfig;
declare function decodeTokenAgentPaymentInCurrency(accountData: Buffer): TokenAgentPaymentInCurrency;
declare function decodeTokenAgentPayments(accountData: Buffer): TokenAgentPayments;

/**
 * @pump-fun/agent-payments-sdk
 * TypeScript SDK for Pump Agent Payments
 */

declare const PUMP_AGENT_PAYMENTS_PROGRAM_ID: PublicKey;
declare function getProgram(connection: Connection): Program<PumpAgentPayments>;

export { type AcceptPaymentParams, type AcceptPaymentSimpleParams, type AgentBalances, BONDING_CURVE_SEED, BUYBACK_AUTHORITY_SEED, type BuybackTriggerParams, type CreateParams, type DistributePaymentsParams, type ExtendAccountParams, GLOBAL_CONFIG_SEED, type GlobalConfig, INVOICE_ID_SEED, OFFLINE_PUMP_PROGRAM, PAYMENT_IN_CURRENCY_SEED, PROGRAM_ID, PUMP_AGENT_PAYMENTS_PROGRAM_ID, PUMP_PROGRAM_ID, PumpAgent, PumpAgentOffline, type PumpAgentPayments, TOKEN_AGENT_PAYMENTS_SEED, type TokenAgentPaymentInCurrency, type TokenAgentPayments, type UpdateAuthorityParams, type UpdateBuybackBpsOptions, type UpdateBuybackBpsParams, type VaultBalance, WITHDRAW_AUTHORITY_SEED, type WithdrawParams, decodeGlobalConfig, decodeTokenAgentPaymentInCurrency, decodeTokenAgentPayments, getBondingCurvePDA, getBuybackAuthorityPDA, getGlobalConfigPDA, getInvoiceIdPDA, getOfflineProgram, getPaymentInCurrencyPDA, getProgram, getPumpProgram, getPumpProgramWithFallback, getTokenAgentPaymentsPDA, getWithdrawAuthorityPDA };
