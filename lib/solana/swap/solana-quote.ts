// scripts/solana-quote.ts
import { getHeaders } from '../../shared';

// Type definitions for the response
interface QuoteResponse {
    code: string;
    msg: string;
    data: Array<{
        routerResult: {
            toTokenAmount: string;
            estimatedGas: string;
            gasFee: string;
            priceImpact: string;
        };
        tx: {
            data: string;
            chainId: string;
        };
        autoSlippage?: {
            slippage: string;  // The calculated optimal slippage value
        };
    }>;
}

interface QuoteParams {
    chainId: string;
    amount: string;
    fromTokenAddress: string;
    toTokenAddress: string;
    slippage: string;
    autoSlippage?: boolean;
    maxAutoSlippageBps?: string;
}

async function getQuote(params: QuoteParams): Promise<QuoteResponse> {
    const timestamp = new Date().toISOString();
    const requestPath = "/api/v5/dex/aggregator/quote";
    const queryString = "?" + new URLSearchParams({
        ...params,
        autoSlippage: params.autoSlippage ? 'true' : 'false'
    }).toString();

    const headers = getHeaders(timestamp, "GET", requestPath, queryString);

    const response = await fetch(`https://www.okx.com${requestPath}${queryString}`, {
        method: "GET",
        headers
    });

    if (!response.ok) {
        throw new Error(`API request failed: ${response.statusText}`);
    }

    const data = await response.json();

    if (data.code !== '0') {
        throw new Error(`API error: ${data.msg}`);
    }

    return data;
}

async function main() {
    try {
        console.log('Getting Solana quote with Auto Slippage...');

        const params: QuoteParams = {
            chainId: '501', // Solana Chain ID
            amount: '10000000000',
            fromTokenAddress: 'So11111111111111111111111111111111111111112', // Wrapped SOL
            toTokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
            slippage: '0.1',
            autoSlippage: true,
            maxAutoSlippageBps: "150" // 1.5% max slippage
        };

        const quote = await getQuote(params);

        // Log the auto-calculated slippage if available
        if (quote.data[0].autoSlippage) {
            console.log('Auto-calculated slippage:', quote.data[0].autoSlippage.slippage + ' bps');
        }

        // Log key quote details
        const result = quote.data[0].routerResult;
        console.log('\nQuote details:');
        console.log('- Amount out:', result.toTokenAmount);
        console.log('- Estimated gas:', result.estimatedGas);
        console.log('- Price impact:', result.priceImpact + '%');

        // Full response for debugging
        console.log('\nFull response:', JSON.stringify(quote, null, 2));

    } catch (error) {
        console.error('Failed to get quote:', error instanceof Error ? error.message : 'Unknown error');
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

export { getQuote, type QuoteParams, type QuoteResponse };