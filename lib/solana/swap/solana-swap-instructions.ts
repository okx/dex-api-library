import {
    Connection,
    Keypair,
    PublicKey,
    TransactionInstruction,
    TransactionMessage,
    VersionedTransaction,
    RpcResponseAndContext,
    SimulatedTransactionResponse,
    AddressLookupTableAccount,
    PublicKeyInitData
} from "@solana/web3.js";
import base58 from "bs58";
import dotenv from "dotenv";
dotenv.config();
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
// CLI execution
async function main() {
    const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com");
    const wallet = Keypair.fromSecretKey(
        Uint8Array.from(base58.decode(process.env.PRIVATE_KEY?.toString() || ""))
    );
    const baseUrl = "https://beta.okex.org/api/v5/dex/aggregator/swap-instruction";
    const params = {
        chainId: "501",
        feePercent: "1",
        amount: "1000000",
        fromTokenAddress: "11111111111111111111111111111111",
        toTokenAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        slippage: "0.1",
        userWalletAddress: process.env.WALLET_ADDRESS || "",
        priceTolerance: "0",
        autoSlippage: "false",
        fromTokenReferrerWalletAddress: process.env.WALLET_ADDRESS || "",
        pathNum: "3"
    }
    const url = `${baseUrl}?${new URLSearchParams(params).toString()}`;
    const { data: { instructionLists, addressLookupTableAddresses } } =
        await fetch(url, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        }).then(res => res.json());
    const instructions: TransactionInstruction[] = [];
    const addressLookupTableAddresses2 = Array.from(new Set(addressLookupTableAddresses));
    console.log(addressLookupTableAddresses2);
    if (instructionLists?.length) {
        instructions.push(...instructionLists.map(createTransactionInstruction));
    }
    // Get lookup table accounts if any
    const addressLookupTableAccounts: AddressLookupTableAccount[] = [];
    if (addressLookupTableAddresses2?.length > 0) {
        console.log("Loading address lookup tables...");
        const lookupTableAccounts = await Promise.all(
            addressLookupTableAddresses2.map(async (address: unknown) => {
                const pubkey = new PublicKey(address as PublicKeyInitData);
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
    console.log("addressLookupTableAccounts:" + addressLookupTableAccounts);
    const latestBlockhash = await connection.getLatestBlockhash('finalized');
    // Create transaction message
    const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions
    }).compileToV0Message(addressLookupTableAccounts);
    console.log(JSON.stringify(instructions));
    const transaction = new VersionedTransaction(messageV0);
    const result: RpcResponseAndContext<SimulatedTransactionResponse> =
        await connection.simulateTransaction(transaction);
    const feePayer = Keypair.fromSecretKey(
        base58.decode(process.env.PRIVATE_KEY?.toString() || "")
    );
    transaction.sign([feePayer])
    const txId = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        maxRetries: 5
    });
    console.log("transaction:" + transaction.serialize())
    console.log(base58.encode(transaction.serialize()));
    console.log("=========simulate result=========")
    // console.log(result);
    result.value.logs?.forEach((log) => {
        console.log(log);
    });
    console.log("Transaction ID:", txId);
    console.log("Explorer URL:", `https://solscan.io/tx/${txId}`);
    process.exit(0);
}
main()