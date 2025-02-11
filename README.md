# OKX DEX Scripts

A comprehensive collection of TypeScript scripts for interacting with the OKX DEX API across Ethereum (EVM), Solana, Ton and Tron networks, supporting both single and cross-chain DEX operations.


## Prerequisites
- Node v20.17.0 or higher
- git
- a Web3 wallet (e.g., [OKX Wallet Extension](https://www.okx.com/download)) for API key generation

## Setup

1. Clone the repository:
```bash
git clone https://github.com/okx/dex-api-library.git
cd dex-api-library
```

2. Install dependencies:
```bash
npm install
```

3. Obtain your project ID, API key, secret key, and passphrase from the [OKX Developer Portal](https://www.okx.com/web3/build/docs/waas/introduction-to-developer-portal-interface)

4. Create `.env` file:
```env
OKX_PROJECT_ID=YOUR_PROJECT_ID
OKX_API_KEY=YOUR_API_KEY
OKX_SECRET_KEY=YOUR_API_SECRET_KEY
OKX_API_PASSPHRASE=YOUR_API_PASSPHRASE

# Optional: Set the network to use for the scripts
SOLANA_RPC_URL=YOUR_SOLANA_RPC_URL
WS_ENDPONT=YOUR_WS_ENDPOINT
```

 _Note: Keep your .env file secure and never commit it to version control_

## Authentication

The project uses a shared authentication utility ([`shared.ts`](./lib/shared.ts)) for OKX API requests. The utility handles request signing and header generation:

```typescript
// shared.ts
import CryptoJS from 'crypto-js';
import dotenv from 'dotenv';

dotenv.config();

export function getHeaders(timestamp: string, method: string, requestPath: string, queryString = "") {
    const apiKey = process.env.OKX_API_KEY;
    const secretKey = process.env.OKX_SECRET_KEY;
    const apiPassphrase = process.env.OKX_API_PASSPHRASE;
    const projectId = process.env.OKX_PROJECT_ID;

    if (!apiKey || !secretKey || !apiPassphrase || !projectId) {
        throw new Error("Missing required environment variables");
    }

    const stringToSign = timestamp + method + requestPath + queryString;
    return {
        "Content-Type": "application/json",
        "OK-ACCESS-KEY": apiKey,
        "OK-ACCESS-SIGN": CryptoJS.enc.Base64.stringify(
            CryptoJS.HmacSHA256(stringToSign, secretKey)
        ),
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": apiPassphrase,
        "OK-ACCESS-PROJECT": projectId,
    };
}
```

The utility takes in a timestamp, method, path, and query string to generate signed API headers. Here's how to use it with a Solana quote request:

```typescript
// Example: Getting a SOL to USDC quote on Solana
const params = {
    chainId: '501',              // Solana Chain ID
    fromTokenAddress: 'So11111111111111111111111111111111111111112',  // Wrapped SOL
    toTokenAddress: 'YUB4Lu7zZayKaxC8jaqAMaR6ZBvq9Uuz2Z1NcFesEt1',  // USDC
    amount: '10000000000',       // Amount in lamports
    slippage: '0.1'             // 0.1% slippage tolerance
};

const timestamp = new Date().toISOString();
const requestPath = "/api/v5/dex/aggregator/quote";
const queryString = "?" + new URLSearchParams(params).toString();

// Generate headers for the request using the shared utility function
const headers = getHeaders(timestamp, "GET", requestPath, queryString);

// Make the request with the generated headers
const response = await fetch(`https://www.okx.com${requestPath}${queryString}`, {
    method: "GET",
    headers
});
```

The complete implementation can be found in [solana-quote.ts](./lib/solana/swap/solana-quote.ts).

## Available Scripts

### Run Individual Commands

To run individual commands, you can use the following scripts with the target network as an argument (e.g., `evm`, `solana`, `ton`, `tron`):

```bash
# Individual Commands
npm run quote:<target_network>                          # Get swap quotes
npm run swap:solana -- <amount> <fromToken> <toToken>   # Execute a swap
npm run swap-data:<target_network>                      # Get swap data
npm run chain:<target_network>                          # Get chain info
npm run tokens:<target_network>                         # List supported tokens
npm run liquidity:<target_network>                      # Get liquidity info
npm run bridge-tokens:<target_network>                  # List bridge tokens
npm run bridges:<target_network>                        # Get bridge info
npm run cross-chain-quote:<target_network>              # Get cross-chain quotes
npm run token-pairs:<target_network>                    # List token pairs
```

Example:

```bash
npm run quote:solana
```

You can also run all scripts for a specific network using the following commands:

```bash
npm run quote:<target_network>
```

Example:
```bash
npm run all:solana
```

### Run All Commands
```bash
npm run get-all    # Run all 'GET' scripts for EVM, Solana, Ton, and Tron
```

## Chain IDs & Common Token Addresses

To retrieve token swap quotes, you need to provide the chain ID and token addresses. Here's the basic structure found in the 'quote' scripts:

```typescript
const params = {
    chainId: '1',              // Network chain ID
    fromTokenAddress: '',      // Source token address
    toTokenAddress: '',        // Destination token address
    amount: '1000000000',      // Amount in token's smallest unit (consider decimals)
    slippage: '0.1',          // 0.1% slippage tolerance
};
```

### Native Token Addresses
Each blockchain has a specific address to represent its native token (ETH, SOL, etc.). When swapping native tokens, use these addresses:

| Chain | Native Token Address |
|-------|---------------------|
| EVM Networks | 0x44857f8c5643f079a31ee5fd2fbb143768d9ad57 |
| Solana | 11111111111111111111111111111111 |
| Tron | TFARRbyF4bVPk8BGpHWEBVUHhzoZASxqnr |
| Ton | UQCp7CkN4KRXIAl17R5O6xmgpmHHJBrX12khvrNUgz1eO9vm |


### EVM

All scripts in the [`lib/evm`](./lib/evm/) directory accept any valid EVM chain ID, maintaining consistent functionality across networks.

For Example:
- Ethereum ('1')
- X Layer ('196')
- Polygon ('137')
- Base ('8453') 
- Arbitrum ('42161')
- You can find more supported chains in the [OKX OS Documentation](https://www.okx.com/web3/build/docs/waas/okx-waas-supported-networks)

Common EVM Tokens (Ethereum addresses):
```typescript
const ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'  // Native ETH
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7' // USDT
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' // USDC
```

### Solana ('501')
```typescript
const SOL = '11111111111111111111111111111111'                // Native SOL
const WSOL = 'So11111111111111111111111111111111111111112'   // Wrapped SOL
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' // USDC
```

### TON ('607')
```typescript
const TON = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c'  // Native TON
const USDC = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs' // USDT
```

### TRON ('195')
```typescript
const TRX = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'  // Native TRX
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' // USDT
```

## Resources

The examples in this repository were built using the [OKX DEX API Documentation](https://www.okx.com/web3/build/docs/waas/dex-api-reference). 

Each API endpoint is implemented in the corresponding scripts within this repository, providing a comprehensive overview of the available functionality.

### DEX Aggregator APIs
- [Get Supported Chains](https://www.okx.com/web3/build/docs/waas/dex-get-aggregator-supported-chains) - List all supported chains for DEX aggregation
- [Get Supported Tokens](https://www.okx.com/web3/build/docs/waas/dex-get-tokens) - Retrieve available tokens for trading
- [Get Liquidity Sources](https://www.okx.com/web3/build/docs/waas/dex-get-liquidity) - View available liquidity sources
- [Get Quote](https://www.okx.com/web3/build/docs/waas/dex-get-quote) - Obtain price quotes for token swaps

### Cross-Chain Bridge APIs
- [Get Bridge Supported Chains](https://www.okx.com/web3/build/docs/waas/dex-get-supported-chains) - List all supported chains for cross-chain bridging
- [Get Cross-Chain Tokens](https://www.okx.com/web3/build/docs/waas/dex-crosschain-get-tokens) - View tokens available for cross-chain transfers
- [Get Supported Bridge Tokens](https://www.okx.com/web3/build/docs/waas/dex-get-supported-tokens) - List all tokens supported by bridges
- [Get Bridge Token Pairs](https://www.okx.com/web3/build/docs/waas/dex-get-supported-bridge-tokens-pairs) - View available token pairs for bridging
- [Get Supported Bridges](https://www.okx.com/web3/build/docs/waas/dex-get-supported-bridges) - List all supported bridge protocols
- [Get Route Information](https://www.okx.com/web3/build/docs/waas/dex-get-route-information) - Obtain cross-chain routing details

## Ways to Contribute

### Join Community Discussions
Join our [Discord community](https://discord.gg/eQ6mVN39) to help other developers troubleshoot their integration issues and share your experience with the SOR SmartContract. Our Discord is the main hub for technical discussions, questions, and real-time support.

### Open an Issue
- Open [issues](https://github.com/okx/dex-api-library/issues) to suggest features or report minor bugs
- Before opening a new issue, search existing issues to avoid duplicates
- When requesting features, include details about use cases and potential impact

### Submit Pull Requests
1. Fork the repository
2. Create a feature branch
3. Make your changes
5. Submit a pull request

### Pull Request Guidelines
- Discuss non-trivial changes in an issue first
- Include tests for new functionality
- Update documentation as needed
- Add a changelog entry describing your changes in the PR
- PRs should be focused and preferably address a single concern

## Questions?
- Open a discussion [issue](https://github.com/okx/dex-api-library/issues) for general questions
- Join our [community](https://discord.gg/eQ6mVN39) for real-time discussions
- Review existing issues and discussions
