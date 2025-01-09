import base58 from "bs58";
import BN from "bn.js";
import * as solanaWeb3 from "@solana/web3.js";
import {
    Connection,
    ComputeBudgetProgram,
    Transaction,
    VersionedTransaction,
    TransactionInstruction,
    Blockhash,
    Keypair,
    PublicKey
} from "@solana/web3.js";
import cryptoJS from "crypto-js";
import dotenv from 'dotenv';

dotenv.config();

// Environment variables with type guards
if (!process.env.OKX_API_KEY) throw new Error("OKX_API_KEY is required");
if (!process.env.OKX_SECRET_KEY) throw new Error("OKX_SECRET_KEY is required");
if (!process.env.OKX_API_PASSPHRASE) throw new Error("OKX_API_PASSPHRASE is required");
if (!process.env.OKX_PROJECT_ID) throw new Error("OKX_PROJECT_ID is required");
if (!process.env.WALLET_ADDRESS) throw new Error("WALLET_ADDRESS is required");
if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY is required");
if (!process.env.SOLANA_RPC_URL) throw new Error("SOLANA_RPC_URL is required");


const apiKey = process.env.OKX_API_KEY;
const secretKey = process.env.OKX_SECRET_KEY;
const apiPassphrase = process.env.OKX_API_PASSPHRASE;
const projectId = process.env.OKX_PROJECT_ID;
const userAddress = process.env.WALLET_ADDRESS;
const userPrivateKey = process.env.PRIVATE_KEY;
const solanaRpcUrl = process.env.SOLANA_RPC_URL;
const solanaWsUrl = process.env.SOLANA_WS_URL;

// Enhanced Constants for MEV Protection
const SOLANA_CHAIN_ID = "501";
const BASE_COMPUTE_UNITS = 300000;
const MAX_COMPUTE_UNITS = 1200000;
const MAX_RETRIES = 3;
const PRIORITY_LEVELS = {
    LOW: 1_000,
    MEDIUM: 10_000,
    HIGH: 100_000,
    VERY_HIGH: 1_000_000
};
const MIN_CONTEXT_SLOT_DISTANCE = 10;

// Interfaces
interface TransactionConfig {
    priorityLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH';
    computeUnits?: number;
    skipPreflight?: boolean;
    minContextSlot?: number;
}

interface ProtectedTransactionBundle {
    transaction: Transaction;
    priorityFee: number;
    computeUnits: number;
    minContextSlot: number;
}

interface BlockhashWithExpiryBlockHeight {
    blockhash: Blockhash;
    lastValidBlockHeight: number;
}

// Enhanced connection with MEV protection settings
const connection = new Connection(`${solanaRpcUrl}`, {
    confirmTransactionInitialTimeout: 5000,
    wsEndpoint: solanaWsUrl,
    commitment: 'confirmed'
});

// Utility Functions
function convertAmount(amount: string, decimals: number): string {
    try {
        if (!amount || isNaN(parseFloat(amount))) {
            throw new Error("Invalid amount");
        }
        const value = parseFloat(amount);
        if (value <= 0) {
            throw new Error("Amount must be greater than 0");
        }
        return new BN(Math.floor(value * Math.pow(10, decimals))).toString();
    } catch (err) {
        console.error("Amount conversion error:", err);
        throw new Error("Invalid amount format");
    }
}

function getHeaders(timestamp: string, method: string, requestPath: string, queryString = "") {
    if (!apiKey || !secretKey || !apiPassphrase || !projectId) {
        throw new Error("Missing required environment variables");
    }

    const stringToSign = timestamp + method + requestPath + queryString;
    return {
        "Content-Type": "application/json",
        "OK-ACCESS-KEY": apiKey,
        "OK-ACCESS-SIGN": cryptoJS.enc.Base64.stringify(
            cryptoJS.HmacSHA256(stringToSign, secretKey)
        ),
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": apiPassphrase,
        "OK-ACCESS-PROJECT": projectId,
    };
}

// MEV Protection Functions
function calculateComputeUnits(tx: Transaction | VersionedTransaction): number {
    let instructionCount: number;

    if (tx instanceof VersionedTransaction) {
        instructionCount = tx.message.compiledInstructions.length;
    } else {
        instructionCount = tx.instructions.length;
    }

    const baseUnits = BASE_COMPUTE_UNITS;
    const computeUnits = Math.min(
        baseUnits * Math.ceil(instructionCount / 2),
        MAX_COMPUTE_UNITS
    );
    return computeUnits;
}

async function calculatePriorityFee(): Promise<number> {
    try {
        const recentPrioritization = await connection.getRecentPrioritizationFees();
        if (recentPrioritization.length === 0) return PRIORITY_LEVELS.MEDIUM;

        const maxFee = Math.max(
            ...recentPrioritization.map(fee => fee.prioritizationFee)
        );
        return Math.min(maxFee * 1.2, PRIORITY_LEVELS.VERY_HIGH);
    } catch {
        return PRIORITY_LEVELS.MEDIUM;
    }
}

// Core API Functions
async function getTokenInfo(fromTokenAddress: string, toTokenAddress: string) {
    const timestamp = new Date().toISOString();
    const requestPath = "/api/v5/dex/aggregator/quote";
    const params = {
        chainId: SOLANA_CHAIN_ID,
        fromTokenAddress,
        toTokenAddress,
        amount: "1000000",
        slippage: "0.5",
    };

    const queryString = "?" + new URLSearchParams(params).toString();
    const headers = getHeaders(timestamp, "GET", requestPath, queryString);

    const response = await fetch(
        `https://www.okx.com${requestPath}${queryString}`,
        { method: "GET", headers }
    );

    if (!response.ok) {
        throw new Error(`Failed to get quote: ${await response.text()}`);
    }

    const data = await response.json();
    if (data.code !== "0" || !data.data?.[0]) {
        throw new Error("Failed to get token information");
    }

    const quoteData = data.data[0];
    return {
        fromToken: {
            symbol: quoteData.fromToken.tokenSymbol,
            decimals: parseInt(quoteData.fromToken.decimal),
            price: quoteData.fromToken.tokenUnitPrice,
            isHoneyPot: quoteData.fromToken.isHoneyPot
        },
        toToken: {
            symbol: quoteData.toToken.tokenSymbol,
            decimals: parseInt(quoteData.toToken.decimal),
            price: quoteData.toToken.tokenUnitPrice,
            isHoneyPot: quoteData.toToken.isHoneyPot
        }
    };
}
// --------------------------------------------------------------------------------------

async function buildProtectedTransaction(
    tx: Transaction | VersionedTransaction,
    swapData: any
): Promise<Transaction> {
    try {
        const computeUnits = calculateComputeUnits(tx);
        const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
            units: computeUnits
        });

        const priorityFee = await calculatePriorityFee();
        const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: priorityFee
        });

        const feePayer = Keypair.fromSecretKey(
            base58.decode(userPrivateKey)
        );

        if (tx instanceof VersionedTransaction) {
            console.log("Converting versioned transaction...");
            const newTx = new Transaction();

            // Set the fee payer and blockhash first
            newTx.feePayer = feePayer.publicKey;
            newTx.recentBlockhash = tx.message.recentBlockhash;

            // Add compute budget instructions only once at the beginning
            newTx.add(computeBudgetIx);
            newTx.add(priorityFeeIx);

            console.log("Processing", tx.message.compiledInstructions.length, "instructions");

            // Get all account keys including lookup table accounts
            const allAccountKeys = [
                ...tx.message.staticAccountKeys,
                ...(tx.message.addressTableLookups || []).flatMap(lookup => {
                    return [
                        ...lookup.writableIndexes,
                        ...lookup.readonlyIndexes
                    ];
                })
            ];

            console.log("Total account keys:", allAccountKeys.length);

            // Identify potential signers from original transaction
            const originalSigners = new Set(
                tx.message.staticAccountKeys
                    .filter((_, index) => tx.message.isAccountSigner(index))
                    .map(key => key.toBase58())
            );

            // Prioritized programs for instruction inclusion
            const prioritizedPrograms = new Set([
                "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",  // Token Program
                "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",  // Associated Token Account Program
                solanaWeb3.SystemProgram.programId.toBase58(),
                solanaWeb3.StakeProgram.programId.toBase58()
            ]);

            // Use a more strict deduplication and size reduction strategy
            const uniqueInstructions: Map<string, TransactionInstruction> = new Map();
            const requiredSigners: PublicKey[] = [feePayer.publicKey];

            for (let i = 0; i < tx.message.compiledInstructions.length; i++) {
                const compiledIx = tx.message.compiledInstructions[i];

                // Map account metas using the complete key set
                const accountMetas = compiledIx.accountKeyIndexes.map(index => {
                    const pubkey = allAccountKeys[index];
                    if (!pubkey) return null;
                    return {
                        pubkey,
                        isSigner: tx.message.isAccountSigner(index),
                        isWritable: tx.message.isAccountWritable(index)
                    };
                }).filter((meta): meta is NonNullable<typeof meta> => meta !== null);

                // Get program ID
                const programId = allAccountKeys[compiledIx.programIdIndex];
                if (!programId) continue;

                // Create instruction
                const instruction = new TransactionInstruction({
                    programId: programId instanceof PublicKey
                        ? programId
                        : new PublicKey(programId),
                    keys: accountMetas.map(meta => ({
                        pubkey: meta.pubkey instanceof PublicKey
                            ? meta.pubkey
                            : new PublicKey(meta.pubkey),
                        isSigner: meta.isSigner,
                        isWritable: meta.isWritable
                    })),
                    data: Buffer.from(compiledIx.data)
                });

                // Generate a unique key for the instruction
                const programIdBase58 = instruction.programId.toBase58();
                const instructionKey = `${programIdBase58}-${instruction.keys.map(k => k.pubkey.toBase58()).join(',')
                    }-${instruction.data.toString('base64')}`;

                // Prioritization logic
                const isPrioritizedProgram = prioritizedPrograms.has(programIdBase58);

                // Only add if not already present and is a prioritized program
                if (isPrioritizedProgram && !uniqueInstructions.has(instructionKey)) {
                    uniqueInstructions.set(instructionKey, instruction);
                    console.log(`Added instruction for ${programIdBase58}`);

                    // Collect required signers from this instruction
                    instruction.keys
                        .filter(key => key.isSigner)
                        .forEach(key => {
                            const keyBase58 = key.pubkey.toBase58();
                            if (originalSigners.has(keyBase58) &&
                                !requiredSigners.some(s => s.toBase58() === keyBase58)) {
                                requiredSigners.push(key.pubkey);
                            }
                        });
                }
            }

            // Add prioritized unique instructions to transaction
            const finalInstructions = Array.from(uniqueInstructions.values());
            finalInstructions.forEach(ix => newTx.add(ix));

            // Verify transaction
            if (!newTx.recentBlockhash) {
                throw new Error('Missing recent blockhash');
            }
            if (!newTx.feePayer) {
                throw new Error('Missing fee payer');
            }
            if (newTx.instructions.length === 0) {
                throw new Error('No instructions in transaction');
            }

            // Collect all required signatures
            console.log("Required signers:", requiredSigners.map(s => s.toBase58()));

            // Replace the entire function body with a simpler approach
            return {
                ...newTx,
                requiredSigners // Attach required signers for later use
            } as unknown as Transaction;
        } else {
            // Legacy transaction handling remains the same
            console.log("Processing legacy transaction...");
            tx.feePayer = feePayer.publicKey;

            // Remove any existing compute budget instructions to prevent duplicates
            const computeBudgetProgramId = ComputeBudgetProgram.programId;
            tx.instructions = tx.instructions.filter(
                ix => !ix.programId.equals(computeBudgetProgramId)
            );

            // Add compute budget instructions at the start
            tx.instructions.unshift(computeBudgetIx, priorityFeeIx);

            // Verify transaction
            if (!tx.recentBlockhash) {
                throw new Error('Missing recent blockhash in legacy transaction');
            }
            if (!tx.feePayer) {
                throw new Error('Missing fee payer in legacy transaction');
            }
            if (tx.instructions.length === 0) {
                throw new Error('No instructions in legacy transaction');
            }

            return tx;
        }
    } catch (error) {
        console.error('Error in buildProtectedTransaction:', error);
        throw error;
    }
}

// --------------------------------------------------------------------------------------

async function broadcastProtectedTransaction(
    tx: Transaction,
    recentBlockHash: BlockhashWithExpiryBlockHeight
): Promise<string> {
    const slot = await connection.getSlot();
    if (recentBlockHash.lastValidBlockHeight - slot < 10) {
        console.log("Warning: Low slot distance, but proceeding with transaction");
    }

    const txId = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 5,
        preflightCommitment: 'processed'
    });

    const confirmation = await connection.confirmTransaction({
        signature: txId,
        blockhash: recentBlockHash.blockhash,
        lastValidBlockHeight: recentBlockHash.lastValidBlockHeight
    }, 'confirmed');

    if (confirmation?.value?.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    return txId;
}

async function main() {
    try {
        const args = process.argv.slice(2);
        if (args.length < 3) {
            console.log("Usage: ts-node swap.ts <amount> <fromTokenAddress> <toTokenAddress>");
            console.log("Example: ts-node swap.ts 1.5 11111111111111111111111111111111 EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
            process.exit(1);
        }

        const [amount, fromTokenAddress, toTokenAddress] = args;

        if (!userPrivateKey || !userAddress) {
            throw new Error("Private key or user address not found");
        }

        // Get token information with honeypot check
        console.log("Getting token information...");
        const tokenInfo = await getTokenInfo(fromTokenAddress, toTokenAddress);

        // Honeypot protection
        if (tokenInfo.toToken.isHoneyPot) {
            throw new Error("Destination token detected as potential honeypot");
        }

        console.log(`From: ${tokenInfo.fromToken.symbol} (${tokenInfo.fromToken.decimals} decimals)`);
        console.log(`To: ${tokenInfo.toToken.symbol} (${tokenInfo.toToken.decimals} decimals)`);

        const rawAmount = convertAmount(amount, tokenInfo.fromToken.decimals);
        console.log(`Amount in ${tokenInfo.fromToken.symbol} base units:`, rawAmount);

        // Enhanced swap parameters
        const quoteParams = {
            chainId: SOLANA_CHAIN_ID,
            amount: rawAmount,
            fromTokenAddress,
            toTokenAddress,
            slippage: "0.5",
            userWalletAddress: userAddress,
            computeUnitPrice: (await calculatePriorityFee()).toString()
        } as Record<string, string>;

        const timestamp = new Date().toISOString();
        const requestPath = "/api/v5/dex/aggregator/swap";
        const queryString = "?" + new URLSearchParams(quoteParams).toString();
        const headers = getHeaders(timestamp, "GET", requestPath, queryString);

        console.log("Requesting protected swap quote...");
        const response = await fetch(
            `https://www.okx.com${requestPath}${queryString}`,
            { method: "GET", headers }
        );

        const data = await response.json();
        if (data.code !== "0") {
            throw new Error(`API Error: ${data.msg}`);
        }

        const swapData = data.data[0];

        // Price impact protection
        if (swapData.priceImpactPercentage && parseFloat(swapData.priceImpactPercentage) > 3) {
            throw new Error(`High price impact detected: ${swapData.priceImpactPercentage}%`);
        }

        const outputAmount = parseFloat(swapData.routerResult.toTokenAmount) / Math.pow(10, tokenInfo.toToken.decimals);
        console.log("\nProtected Swap Quote:");
        console.log(`Input: ${amount} ${tokenInfo.fromToken.symbol} ($${(parseFloat(amount) * parseFloat(tokenInfo.fromToken.price)).toFixed(2)})`);
        console.log(`Output: ${outputAmount.toFixed(tokenInfo.toToken.decimals)} ${tokenInfo.toToken.symbol} ($${(outputAmount * parseFloat(tokenInfo.toToken.price)).toFixed(2)})`);
        console.log(`Price Impact: ${swapData.priceImpactPercentage}%`);

        console.log("\nExecuting protected swap transaction...");
        let retryCount = 0;
        while (retryCount < MAX_RETRIES) {
            try {
                if (!swapData || (!swapData.tx && !swapData.data)) {
                    throw new Error("Invalid swap data structure");
                }

                const transactionData = swapData.tx?.data || swapData.data;
                if (!transactionData || typeof transactionData !== 'string') {
                    throw new Error("Invalid transaction data");
                }

                const recentBlockHash = await connection.getLatestBlockhash('finalized');
                console.log("Got blockhash:", recentBlockHash.blockhash);

                const decodedTransaction = base58.decode(transactionData);
                let tx;

                try {
                    tx = VersionedTransaction.deserialize(decodedTransaction);
                    console.log("Successfully created versioned transaction");
                    tx.message.recentBlockhash = recentBlockHash.blockhash;
                } catch (e) {
                    console.log("Versioned transaction failed, trying legacy:", e);
                    tx = Transaction.from(decodedTransaction);
                    console.log("Successfully created legacy transaction");
                    tx.recentBlockhash = recentBlockHash.blockhash;
                }

                console.log("Building protected transaction...");
                const protectedTx = await buildProtectedTransaction(tx, swapData);

                // Extract required signers if available
                const requiredSigners = (protectedTx as any).requiredSigners || [];
                console.log("Required signers:", requiredSigners.map((s: PublicKey) => s.toBase58()));

                console.log("Creating fee payer...");
                const feePayer = Keypair.fromSecretKey(base58.decode(userPrivateKey));

                console.log("Verifying transaction before signing...");
                if (!protectedTx.feePayer) {
                    throw new Error('Transaction missing fee payer');
                }
                if (!protectedTx.recentBlockhash) {
                    throw new Error('Transaction missing recent blockhash');
                }
                if (protectedTx.instructions.length === 0) {
                    throw new Error('Transaction has no instructions');
                }

                console.log("Signing transaction...");


                try {
                    // Try to sign with required signers if available
                    let signedTx: Transaction;

                    // Explicitly convert to Transaction
                    signedTx = Transaction.from(protectedTx as unknown as Buffer | Uint8Array | number[]);

                    if (requiredSigners.length > 0) {
                        // Explicitly type the mapping and filtering
                        const signerKeypairs: Keypair[] = requiredSigners
                            .map((signer: PublicKey) => {
                                // If the signer is the fee payer, use that
                                if (signer.toBase58() === feePayer.publicKey.toBase58()) {
                                    return feePayer;
                                }
                                return null;
                            })
                            .filter((kp: any): kp is Keypair => kp !== null);

                        // Sign with available signers
                        if (signerKeypairs.length > 0) {
                            for (const kp of signerKeypairs) {
                                console.log(`Signing with ${kp.publicKey.toBase58()}`);
                                signedTx.partialSign(kp);
                            }
                        } else {
                            // Fallback to fee payer signing
                            signedTx.partialSign(feePayer);
                        }
                    } else {
                        // Fallback to only fee payer signing
                        signedTx.partialSign(feePayer);
                    }

                    console.log("Transaction signed successfully");
                } catch (error) {
                    console.error("Error during signing:", error);
                    throw error;
                }

                // --------------------------------------------------------------------------------------------

                if (!protectedTx.signatures || protectedTx.signatures.length === 0) {
                    throw new Error('Transaction signing failed - no signatures present');
                }

                console.log("Broadcasting transaction...");
                const txId = await broadcastProtectedTransaction(protectedTx, recentBlockHash);

                console.log("\nProtected swap completed successfully!");
                console.log("Transaction ID:", txId);
                console.log("Explorer URL:", `https://solscan.io/tx/${txId}`);

                process.exit(0);
            } catch (error) {
                console.error(`Protected attempt ${retryCount + 1} failed:`, error);
                retryCount++;

                if (retryCount === MAX_RETRIES) {
                    throw error;
                }

                const jitter = Math.random() * 1000;
                await new Promise(resolve => setTimeout(resolve, (2000 * Math.pow(2, retryCount)) + jitter));
            }
        }
    } catch (error) {
        console.error("Error:", error instanceof Error ? error.message : "Unknown error");
        process.exit(1);
    }
}

// Entry point
if (require.main === module) {
    main().catch((error) => {
        console.error("Fatal error:", error);
        process.exit(1);
    });
}

// Export functions for potential reuse
export {
    getTokenInfo,
    buildProtectedTransaction,
    broadcastProtectedTransaction,
    calculatePriorityFee,
    calculateComputeUnits,
    convertAmount
};