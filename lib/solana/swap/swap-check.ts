import {
    Connection,
    PublicKey,
    VersionedTransaction,
    TransactionMessage,
    AddressLookupTableAccount,
    TransactionInstruction,
    Keypair
} from '@solana/web3.js';
import { Wallet } from '@project-serum/anchor';
import bs58 from 'bs58';
import axios from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();

const connection = new Connection('https://fullnode.okg.com/sol/native/analysis/rpc');

if (!process.env.PRIVATE_KEY) {
    throw new Error('PRIVATE_KEY environment variable is required');
}
const wallet = new Wallet(Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY)));

async function getQuote() {
    const config = {
        method: 'get',
        maxBodyLength: Infinity,
        url: 'https://quote-api.jup.ag/v6/quote',
        headers: {
            'Accept': 'application/json'
        },
        params: {
            inputMint: "So11111111111111111111111111111111111111112",  // SOL
            outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  // USDC
            amount: "1000000", // 0.01 SOL
            slippageBps: 50
        }
    };

    const response = await axios.request(config);
    return response.data;
}

async function getSwapInstructions(quoteResponse: any, walletPublicKey: string) {
    const swapRequestData = {
        userPublicKey: walletPublicKey,
        wrapAndUnwrapSol: true,
        useSharedAccounts: true,
        computeUnitPriceMicroLamports: "auto",
        asLegacyTransaction: false,
        useTokenLedger: false,
        dynamicComputeUnitLimit: true,
        skipUserAccountsRpcCalls: true,
        quoteResponse: {
            inputMint: quoteResponse.inputMint,
            inAmount: quoteResponse.inAmount,
            outputMint: quoteResponse.outputMint,
            outAmount: quoteResponse.outAmount,
            otherAmountThreshold: quoteResponse.otherAmountThreshold,
            swapMode: quoteResponse.swapMode,
            slippageBps: quoteResponse.slippageBps,
            platformFee: quoteResponse.platformFee,
            priceImpactPct: quoteResponse.priceImpactPct,
            routePlan: quoteResponse.routePlan,
            contextSlot: quoteResponse.contextSlot,
            timeTaken: quoteResponse.timeTaken
        }
    };

    const config = {
        method: 'post',
        maxBodyLength: Infinity,
        url: 'https://quote-api.jup.ag/v6/swap-instructions',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        data: swapRequestData
    };

    const response = await axios.request(config);
    return response.data;
}

async function main() {
    try {
        console.log('Getting quote...');
        const quoteResponse = await getQuote();

        console.log('Getting swap instructions...');
        const instructions = await getSwapInstructions(quoteResponse, wallet.publicKey.toString());

        if (!instructions || !instructions.swapInstruction) {
            throw new Error('Invalid response from Jupiter API');
        }

        const addressLookupTableAccounts = await getAddressLookupTableAccounts(
            connection,
            instructions.addressLookupTableAddresses
        );

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

        const messageV0 = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: blockhash,
            instructions: [
                ...(instructions.setupInstructions?.map(deserializeInstruction) || []),
                deserializeInstruction(instructions.swapInstruction),
                ...(instructions.cleanupInstruction ? [deserializeInstruction(instructions.cleanupInstruction)] : []),
            ],
        }).compileToV0Message(addressLookupTableAccounts);

        const transaction = new VersionedTransaction(messageV0);
        transaction.sign([wallet.payer]);

        const txid = await connection.sendRawTransaction(transaction.serialize(), {
            skipPreflight: true,
            maxRetries: 2
        });

        await connection.confirmTransaction({
            blockhash,
            lastValidBlockHeight,
            signature: txid
        });

        console.log(`Transaction successful! https://solscan.io/tx/${txid}`);
    } catch (error) {
        if (axios.isAxiosError(error)) {
            console.error('API Error:', error.response?.data || error.message);
        } else {
            console.error('Script failed:', error);
        }
        process.exit(1);
    }
}

// Helper functions
function deserializeInstruction(instruction: any): TransactionInstruction {
    return new TransactionInstruction({
        programId: new PublicKey(instruction.programId),
        keys: instruction.accounts.map((key: any) => ({
            pubkey: new PublicKey(key.pubkey),
            isSigner: key.isSigner,
            isWritable: key.isWritable,
        })),
        data: Buffer.from(instruction.data, 'base64'),
    });
}

async function getAddressLookupTableAccounts(
    connection: Connection,
    keys: string[]
): Promise<AddressLookupTableAccount[]> {
    const addressLookupTableAccountInfos = await connection.getMultipleAccountsInfo(
        keys.map((key) => new PublicKey(key))
    );

    return addressLookupTableAccountInfos.reduce((acc, accountInfo, index) => {
        const addressLookupTableAddress = keys[index];
        if (accountInfo) {
            const addressLookupTableAccount = new AddressLookupTableAccount({
                key: new PublicKey(addressLookupTableAddress),
                state: AddressLookupTableAccount.deserialize(accountInfo.data),
            });
            acc.push(addressLookupTableAccount);
        }
        return acc;
    }, new Array<AddressLookupTableAccount>());
}

main();