// scripts/solana-quote.ts
import { getHeaders } from '../../shared';

async function main() {
    try {
        const params = {
            fromChainId: '1',    // Ethereum Chain ID
            toChainId: '196',     // To BSC
            amount: '1000000000000000000', // 1 ETH (18 decimals)
            fromTokenAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', // Native ETH
            toTokenAddress: '0x74b7f16337b8972027f6196a17a631ac6de26d22', // USDC on X Layer
            slippage: '0.025',    // 2.5% slippage for cross-chain swaps
            sort: '1',            // Optimal route considering all factors
            priceImpactProtectionPercentage: '0.9', // 90% price impact allowed
        };

        const timestamp = new Date().toISOString();
        const requestPath = "/api/v5/dex/cross-chain/quote";
        const queryString = "?" + new URLSearchParams(params).toString();
        const headers = getHeaders(timestamp, "GET", requestPath, queryString);

        console.log('Getting Ethereum to X Layer cross-chain quote...');
        const response = await fetch(`https://www.okx.com${requestPath}${queryString}`, {
            method: "GET",
            headers
        });

        const data = await response.json();
        console.log('Cross-chain quote response:', JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Script failed:', error);
        process.exit(1);
    }
}

main();