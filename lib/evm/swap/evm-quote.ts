
// scripts/evm-quote.ts
import { getHeaders } from '../../shared';

async function main() {
    try {
        const params = {
            chainId: '1', // Ethereum mainnet
            amount: '10000000000000000000', // 10 ETH
            fromTokenAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', // Native ETH
            toTokenAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
            slippage: '0.1',
        };

        const timestamp = new Date().toISOString();
        const requestPath = "/api/v5/dex/aggregator/quote";
        const queryString = "?" + new URLSearchParams(params).toString();
        const headers = getHeaders(timestamp, "GET", requestPath, queryString);

        console.log('Getting EVM quote...');
        const response = await fetch(`https://www.okx.com${requestPath}${queryString}`, {
            method: "GET",
            headers
        });

        const result = await response.json();
        // JSON response
        // console.log(JSON.stringify(result, null, 2));

        const data = result.data[0];
        console.log('Quote Details:');
        console.log('----------------------------------------');
        console.log(`Chain ID: ${data.chainId}`);
        console.log(`From Amount: ${data.fromTokenAmount}`);
        console.log(`To Amount: ${data.toTokenAmount}`);
        console.log(`Trade Fee (USD): ${data.tradeFee}`);
        console.log(`Estimated Gas Fee: ${data.estimateGasFee}`);
        console.log(`Price Impact: ${data.priceImpactPercentage}%`);

        console.log('\nToken Details:');
        console.log('----------------------------------------');
        console.log('From Token:');
        console.log(`- Symbol: ${data.fromToken.tokenSymbol}`);
        console.log(`- Address: ${data.fromToken.tokenContractAddress}`);
        console.log(`- Price: $${data.fromToken.tokenUnitPrice}`);
        console.log(`- Decimals: ${data.fromToken.decimal}`);
        console.log(`- Tax Rate: ${data.fromToken.taxRate}%`);
        console.log(`- Is Honeypot: ${data.fromToken.isHoneyPot}`);

        console.log('\nTo Token:');
        console.log(`- Symbol: ${data.toToken.tokenSymbol}`);
        console.log(`- Address: ${data.toToken.tokenContractAddress}`);
        console.log(`- Price: $${data.toToken.tokenUnitPrice}`);
        console.log(`- Decimals: ${data.toToken.decimal}`);
        console.log(`- Tax Rate: ${data.toToken.taxRate}%`);
        console.log(`- Is Honeypot: ${data.toToken.isHoneyPot}`);

        if (data.dexRouterList && data.dexRouterList.length > 0) {
            console.log('\nDEX Routes:');
            console.log('----------------------------------------');
            data.dexRouterList.forEach((routerInfo: any) => {
                console.log(`Router: ${routerInfo.router}`);

                routerInfo.subRouterList.forEach((subRouter: any) => {
                    console.log('\nProtocols:');
                    subRouter.dexProtocol.forEach((protocol: any) => {
                        console.log(`- ${protocol.dexName}: ${protocol.percent}%`);
                    });
                });
            });
        }

        if (data.quoteCompareList && data.quoteCompareList.length > 0) {
            console.log('\nQuote Comparisons:');
            console.log('----------------------------------------');
            data.quoteCompareList.forEach((quote: any) => {
                console.log(`${quote.dexName}:`);
                console.log(`- Logo: ${quote.dexLogo}`);
                console.log(`- Amount Out: ${quote.amountOut}`);
                console.log(`- Trade Fee: $${quote.tradeFee}`);
            });
        }
    } catch (error) {
        console.error('Script failed:', error);
        process.exit(1);
    }
}

main();
