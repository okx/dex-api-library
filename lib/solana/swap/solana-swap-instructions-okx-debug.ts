import {
    Connection,
    Keypair,
    PublicKey,
    TransactionInstruction,
    TransactionMessage,
    VersionedTransaction,
    AddressLookupTableAccount,
    LAMPORTS_PER_SOL,
    PublicKeyInitData
} from "@solana/web3.js";
import base58 from "bs58";
import dotenv from 'dotenv';
import { getHeaders } from '../../shared';

dotenv.config();

const WSOL = "So11111111111111111111111111111111111111112";
const NATIVE_SOL = "11111111111111111111111111111111";

// Token decimal mapping
const TOKEN_DECIMALS: { [key: string]: number } = {
    [NATIVE_SOL]: 9,
    [WSOL]: 9,
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": 6  // USDC
};

function createTransactionInstruction(instruction: any): TransactionInstruction {
    return new TransactionInstruction({
        programId: new PublicKey(instruction.programId),
        keys: instruction.accounts.map((key: any) => ({
            pubkey: new PublicKey(key.pubkey),
            isSigner: key.isSigner,
            isWritable: key.isWritable
        })),
        data: Buffer.from(instruction.data, 'base64')
    });
}

async function executeSwap(
    amountIn: string,
    inputToken: string,
    outputToken: string
): Promise<string> {
    try {
        console.log("Starting swap...");

        // Initialize connection and wallet
        const connection = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com");
        const wallet = Keypair.fromSecretKey(
            Uint8Array.from(base58.decode(process.env.PRIVATE_KEY || ""))
        );

        // Handle SOL wrapping
        const inputMint = inputToken === NATIVE_SOL ? WSOL : inputToken;
        const outputMint = outputToken === NATIVE_SOL ? WSOL : outputToken;

        // Convert amount to proper decimals
        const decimals = TOKEN_DECIMALS[inputToken] || 9;
        const amount = Math.floor(parseFloat(amountIn) * Math.pow(10, decimals)).toString();
        console.log(`Input amount: ${amountIn} (${amount} base units)`);

        // Get quote
        console.log("Getting quote...");
        const timestamp = new Date().toISOString();
        const quotePath = "/api/v5/dex/aggregator/quote";
        const quoteParams = new URLSearchParams({
            chainId: "501", // Solana chain ID
            amount,
            fromTokenAddress: inputMint,
            toTokenAddress: outputMint,
            priceImpactProtectionPercentage: "0.9",
            feePercent: "1"
        });

        const quoteResponse = await fetch(
            `https://www.okx.com${quotePath}?${quoteParams.toString()}`,
            {
                method: "GET",
                headers: {
                    ...getHeaders(timestamp, "GET", quotePath, `?${quoteParams.toString()}`),
                }
            }
        );

        const quoteData = await quoteResponse.json();
        if (!quoteData.data?.[0]) {
            throw new Error(`Quote error: ${JSON.stringify(quoteData)}`);
        }
        console.log(`Expected output: ${quoteData.data[0].toTokenAmount}`);

        // Get swap instructions
        console.log("Getting swap instructions...");
        const swapPath = '/api/v5/dex/aggregator/swap-instruction';
        const swapParams = new URLSearchParams({
            chainId: "501",
            amount,
            fromTokenAddress: inputMint,
            toTokenAddress: outputMint,
            slippage: "0.05",
            priceImpactProtectionPercentage: "1",
            userWalletAddress: wallet.publicKey.toString(),
            feePercent: "1",
            fromTokenReferrerWalletAddress: wallet.publicKey.toString(),
            computeUnitPriceMicroLamports: '1'
        });

        const { swapInstruction, setupInstructions, cleanupInstruction, addressLookupTableAddresses } = await fetch(
            `https://beta.okex.org${swapPath}?${swapParams.toString()}`,
            {
                method: 'POST',
                headers: {
                    ...getHeaders(timestamp, "POST", swapPath, `?${swapParams.toString()}`),
                }
            }
        ).then(res => res.json()).then(data => data.data[0]);
        const addressLookupTableAccounts: AddressLookupTableAccount[] = [];
        if (addressLookupTableAddresses?.length > 0) {
            console.log("Loading address lookup tables...");
            const lookupTableAccounts = await Promise.all(
                addressLookupTableAddresses.map(async (address: PublicKeyInitData) => {
                    const account = await connection
                        .getAddressLookupTable(new PublicKey(address))
                        .then((res) => res.value);
                    if (!account) {
                        throw new Error(`Could not fetch lookup table account ${address}`);
                    }
                    return account;
                })
            );
            addressLookupTableAccounts.push(...lookupTableAccounts);
        }

        // Compile all instructions
        const instructions: TransactionInstruction[] = [];

        if (setupInstructions?.length) {
            instructions.push(...setupInstructions.map(createTransactionInstruction));
        }

        if (swapInstruction) {
            instructions.push(createTransactionInstruction(swapInstruction));
        }

        if (cleanupInstruction) {
            instructions.push(createTransactionInstruction(cleanupInstruction));
        }

        // Get latest blockhash
        console.log("Building transaction...");
        const latestBlockhash = await connection.getLatestBlockhash('confirmed');

        // Create transaction message
        const messageV0 = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: latestBlockhash.blockhash,
            instructions
        }).compileToV0Message([]);  // OKX doesn't use lookup tables

        // Create versioned transaction
        const transaction = new VersionedTransaction(messageV0);

        // Sign transaction
        transaction.sign([wallet]);

        // Send and confirm transaction with retries
        console.log("Sending transaction...");
        let signature;
        try {
            signature = await connection.sendTransaction(transaction, {
                maxRetries: 3,
                skipPreflight: true,
                preflightCommitment: 'confirmed'
            });

            console.log("Transaction sent:", signature);
            console.log(`https://solscan.io/tx/${signature}`);

            // Wait for confirmation
            const confirmation = await connection.confirmTransaction(
                {
                    signature,
                    blockhash: latestBlockhash.blockhash,
                    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
                },
                'confirmed'
            );

            if (confirmation.value.err) {
                throw new Error(`Transaction failed: ${confirmation.value.err.toString()}`);
            }

            console.log(`\nSwap successful! ✅`);
            return signature;

        } catch (error) {
            if (signature) {
                console.log(`Transaction sent but confirmation failed. Check manually: https://solscan.io/tx/${signature}`);
            }
            throw error;
        }

    } catch (error) {
        console.error("Swap failed:", error);
        throw error;
    }
}

// CLI execution
async function main() {
    try {
        const [amount, inputToken, outputToken] = process.argv.slice(2);

        if (!amount || !inputToken || !outputToken) {
            console.log("Usage: ts-node swap.ts <amount> <inputToken> <outputToken>");
            process.exit(1);
        }

        await executeSwap(amount, inputToken, outputToken);
    } catch (error) {
        console.error("\nError:", error);
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch(console.error);
}

export { executeSwap };