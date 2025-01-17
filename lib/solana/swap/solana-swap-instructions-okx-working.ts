import {
    Connection,
    Keypair,
    PublicKey,
    TransactionInstruction,
    TransactionMessage,
    VersionedTransaction,
    RpcResponseAndContext,
    SimulatedTransactionResponse
} from "@solana/web3.js";
import base58 from "bs58";
import dotenv from "dotenv";
dotenv.config();
function createTransactionInstruction(instruction: any): TransactionInstruction {
    // console.log(new PublicKey(instruction.programId));
    return new TransactionInstruction({
        programId: new PublicKey(instruction.programId.pubkey),
        keys: instruction.keys.map((key: any) => ({
            pubkey: new PublicKey(key.publicKey.pubkey),
            isSigner: key.isSigner,
            isWritable: key.isWritable
        })),
        data: Buffer.from(base58.decode(instruction.data))
    });
}
// CLI execution
async function main() {
    const connection = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com");
    const wallet = Keypair.fromSecretKey(
        Uint8Array.from(base58.decode(process.env.PRIVATE_KEY?.toString() || ""))
    );
    const pubkey = wallet.publicKey


    const baseUrl = 'https://beta.okex.org/api/v5/dex/aggregator/swap-instruction';

    const params = {
        chainId: '501',
        feePercent: '1',
        amount: '100000',
        fromTokenAddress: '11111111111111111111111111111111',
        toTokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        slippage: '0.1',
        userWalletAddress: "CZSSsQwcHNoiGXCsRaybSchkN2ycEWHos9veB5P9akJB",
        priceTolerance: '0',
        autoSlippage: 'false',
        fromTokenReferrerWalletAddress: 'DmTcmrZ7Dz8asHuuvk2G419JMzqdx58brUBidAegaevp',
        pathNum: '1',
        dexIds: '278'
    };

    const queryString = '?' + new URLSearchParams(params).toString();
    const url = baseUrl + queryString;

    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json'
        }
    }).then(res => res.json());

    // const response =
    //     await fetch('https://beta.okex.org/api/v5/dex/aggregator/swap-instruction?chainId=501&feePercent=1&amount=100000&fromTokenAddress=11111111111111111111111111111111&toTokenAddress=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&slippage=0.1&userWalletAddress=HxuPhmAYQwM4CvdJREL8ad3DgDWGVq4xBfy1vgGev5X7&priceTolerance=0&autoSlippage=false&fromTokenReferrerWalletAddress=DmTcmrZ7Dz8asHuuvk2G419JMzqdx58brUBidAegaevp&pathNum=1&dexIds=278', {
    //         method: 'GET',
    //         headers: { 'Content-Type': 'application/json' }
    //     }).then(res => res.json());


    // // Compile all instructions
    const instructions: TransactionInstruction[] = [];
    if (response.data?.length) {
        instructions.push(...response.data.map(createTransactionInstruction));
    }

    const latestBlockhash = await connection.getLatestBlockhash('recent');
    console.log(latestBlockhash);
    // Create transaction message
    const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions
    }).compileToLegacyMessage();
    let transaction;
    transaction = new VersionedTransaction(messageV0);
    const result: RpcResponseAndContext<SimulatedTransactionResponse> =
        await connection.simulateTransaction(transaction)

    const feePayer = Keypair.fromSecretKey(
        base58.decode(process.env.PRIVATE_KEY?.toString() || "")
    );
    transaction.sign([feePayer])

    const txId = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        maxRetries: 5
    });

    // const confirmation = await connection.confirmTransaction({
    //     signature: txId,
    //     blockhash: latestBlockhash.blockhash,
    //     lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
    // }, 'recent');

    // if (confirmation?.value?.err) {
    //     throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    // }
    console.log("=========模拟交易结果=========")
    console.log(JSON.stringify(result, null, 2));
    result.value.logs?.forEach((log) => {
        console.log(log);
    });
    console.log("\nSwap completed successfully!");
    console.log("Transaction ID:", txId);
    console.log("Explorer URL:", `https://solscan.io/tx/${txId}`);
    process.exit(0);
}
main()