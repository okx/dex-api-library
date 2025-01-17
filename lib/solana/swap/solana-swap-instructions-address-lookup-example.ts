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

dotenv.config();

const WSOL = "So11111111111111111111111111111111111111112";
const NATIVE_SOL = "11111111111111111111111111111111";

// Token decimal mapping
const TOKEN_DECIMALS: { [key: string]: number } = {
    [NATIVE_SOL]: 9,
    [WSOL]: 9,
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": 6  // USDT
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
        const quoteResponse = await fetch(
            `https://quote-api.jup.ag/v6/quote?` + new URLSearchParams({
                inputMint,
                outputMint,
                amount,
                slippageBps: "50",
            })
        );

        const quoteData = await quoteResponse.json();
        if (quoteData.error) {
            throw new Error(`Quote error: ${JSON.stringify(quoteData.error)}`);
        }
        console.log(`Expected output: ${quoteData.outAmount}`);

        // Get swap instructions
        console.log("Getting swap instructions...");
        const { swapInstruction, setupInstructions, cleanupInstruction, addressLookupTableAddresses } =
            await fetch('https://quote-api.jup.ag/v6/swap-instructions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    quoteResponse: quoteData,
                    userPublicKey: wallet.publicKey.toString(),
                    computeUnitPriceMicroLamports: 1,
                    wrapUnwrapSOL: true,
                    useSharedAccounts: true
                })
            }).then(res => res.json());

        console.log("swapInstruction data here -------------------------------:", JSON.stringify(swapInstruction, null, 2));
        console.log("-----------------BREAK------------------------------------");

        // Get lookup table accounts if any
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
        }).compileToV0Message(addressLookupTableAccounts);

        // Create versioned transaction
        const transaction = new VersionedTransaction(messageV0);

        // Sign transaction
        transaction.sign([wallet]);

        console.log("Instructions here -------------------------------:", JSON.stringify(instructions, null, 2));
        console.log("-----------------BREAK------------------------------------");
        // console.log("MessageV0 here -------------------------------:", JSON.stringify(messageV0, null, 2)); 
        // console.log("-----------------BREAK------------------------------------");
        console.log("Transaction here -------------------------------:", JSON.stringify(transaction, null, 2));
        console.log("-----------------BREAK------------------------------------");

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

            // Wait for confirmation with shorter timeout
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