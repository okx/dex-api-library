// Required Solana dependencies for DEX interaction
import {
    Connection,          // Handles RPC connections to Solana network
    Keypair,            // Manages wallet keypairs for signing
    PublicKey,          // Handles Solana public key conversion and validation
    TransactionInstruction,    // Core transaction instruction type
    TransactionMessage,        // Builds transaction messages (v0 format)
    VersionedTransaction,      // Supports newer transaction format with lookup tables
    RpcResponseAndContext,     // RPC response wrapper type
    SimulatedTransactionResponse,  // Simulation result type
    AddressLookupTableAccount,     // For transaction size optimization
    PublicKeyInitData              // Public key input type
} from "@solana/web3.js";
import base58 from "bs58";    // Required for private key decoding
import dotenv from "dotenv";  // Environment variable management
dotenv.config();

async function main() {
    // Initialize Solana RPC connection
    // Note: Consider using a reliable RPC endpoint with high rate limits for production
    const connection = new Connection(
        process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com"
    );

    // Initialize wallet for signing
    // This wallet will be the fee payer and transaction signer
    // Ensure it has sufficient SOL for transaction fees
    const wallet = Keypair.fromSecretKey(
        Uint8Array.from(base58.decode(process.env.PRIVATE_KEY?.toString() || ""))
    );

    // DEX aggregator API endpoint
    // This endpoint provides optimized swap routes across multiple DEXs
    const baseUrl = "https://beta.okex.org/api/v5/dex/aggregator/swap-instruction";
    
    // Swap configuration parameters
    const params = {
            chainId: "501",              // Solana mainnet chain ID
            feePercent: "1",            // Platform fee percentage
            amount: "1000000",          // Amount in smallest denomination (e.g., lamports for SOL)
            fromTokenAddress: "11111111111111111111111111111111",  // SOL mint address
            toTokenAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  // USDC mint address
            slippage: "0.1",            // Slippage tolerance in percentage
            userWalletAddress: process.env.WALLET_ADDRESS || "",   // Wallet performing the swap
            priceTolerance: "0",        // Maximum allowed price impact
            autoSlippage: "false",      // Use fixed slippage instead of auto
            fromTokenReferrerWalletAddress: process.env.WALLET_ADDRESS || "",  // For referral fees
            pathNum: "3"                // Maximum routes to consider
        }
    
    // Helper function to convert DEX API instructions to Solana format
    // The DEX returns instructions in a custom format that needs conversion
    function createTransactionInstruction(instruction: any): TransactionInstruction {
        return new TransactionInstruction({
            programId: new PublicKey(instruction.programId),  // DEX program ID
            keys: instruction.accounts.map((key: any) => ({   
                pubkey: new PublicKey(key.pubkey),    // Account address
                isSigner: key.isSigner,     // True if account must sign tx
                isWritable: key.isWritable  // True if instruction modifies account
            })),
            data: Buffer.from(instruction.data, 'base64')  // Instruction parameters
        });
    }

    // Fetch optimal swap route and instructions from DEX
    // This call finds the best price across different DEX liquidity pools
    const url = `${baseUrl}?${new URLSearchParams(params).toString()}`;
    const { data: { instructionLists, addressLookupTableAddresses } } =
        await fetch(url, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        }).then(res => res.json());

    // Process DEX instructions into Solana-compatible format
    const instructions: TransactionInstruction[] = [];
    // Remove duplicate lookup table addresses returned by DEX
    const addressLookupTableAddresses2 = Array.from(new Set(addressLookupTableAddresses));
    console.log("Lookup tables to load:", addressLookupTableAddresses2);
    
    // Convert each DEX instruction to Solana format
    if (instructionLists?.length) {
        instructions.push(...instructionLists.map(createTransactionInstruction));
    }

    // Process lookup tables for transaction optimization
    // Lookup tables are crucial for complex swaps that interact with many accounts
    // They significantly reduce transaction size and cost
    const addressLookupTableAccounts: AddressLookupTableAccount[] = [];
    if (addressLookupTableAddresses2?.length > 0) {
        console.log("Loading address lookup tables...");
        // Fetch all lookup tables in parallel for better performance
        const lookupTableAccounts = await Promise.all(
            addressLookupTableAddresses2.map(async (address: unknown) => {
                const pubkey = new PublicKey(address as PublicKeyInitData);
                // Get lookup table account data from Solana
                const account = await connection
                    .getAddressLookupTable(pubkey)
                    .then((res) => res.value);
                if (!account) {
                    throw new Error(`Could not fetch lookup table account ${address}`);
                }
                return account;
            })
        );
        addressLookupTableAccounts.push(...lookupTableAccounts);
    }
    console.log("Loaded lookup tables:", addressLookupTableAccounts);

    // Get recent blockhash for transaction timing and uniqueness
    // Transactions are only valid for a limited time after this blockhash
    const latestBlockhash = await connection.getLatestBlockhash('finalized');

    // Create versioned transaction message
    // V0 message format required for lookup table support
    const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,     // Fee payer address
        recentBlockhash: latestBlockhash.blockhash,  // Transaction timing
        instructions                     // Swap instructions from DEX
    }).compileToV0Message(addressLookupTableAccounts);  // Include lookup tables
    
    console.log("Swap instructions:", JSON.stringify(instructions));

    // Create new versioned transaction with optimizations
    const transaction = new VersionedTransaction(messageV0);

    // Simulate transaction to check for errors
    // This helps catch issues before paying fees
    const result: RpcResponseAndContext<SimulatedTransactionResponse> =
        await connection.simulateTransaction(transaction);

    // Sign transaction with fee payer wallet
    const feePayer = Keypair.fromSecretKey(
        base58.decode(process.env.PRIVATE_KEY?.toString() || "")
    );
    transaction.sign([feePayer])

    // Send transaction to Solana
    // skipPreflight=false ensures additional validation
    // maxRetries helps handle network issues
    const txId = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,  // Run preflight validation
        maxRetries: 5         // Retry on failure
    });
    
    // Log debugging information
    console.log("Raw transaction:", transaction.serialize());
    console.log("Base58 transaction:", base58.encode(transaction.serialize()));
    
    // Log simulation results for debugging
    console.log("=========simulate result=========");
    result.value.logs?.forEach((log) => {
        console.log(log);
    });
    
    // Log transaction results
    console.log("Transaction ID:", txId);
    console.log("Explorer URL:", `https://solscan.io/tx/${txId}`);
    
    process.exit(0);
}

// Execute swap
main()