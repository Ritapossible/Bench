import { parseAbi } from 'viem';

/**
 * BSC mainnet addresses the fork seeders drive.
 *
 * Every one was verified against the chain rather than copied from
 * documentation: each has code, `vUSDT.underlying()` returns the real USDT,
 * `comptroller.markets(vUSDT)` returns listed with a 0.8 collateral factor,
 * and the position manager reports the factory it belongs to. An address that
 * is wrong here does not fail loudly - it fails as an agent that could not
 * work its position, which reads as a finding about the agent.
 */
export const VENUS = {
  comptroller: '0xfD36E2c2a6789Db23113685031d7F16329158384',
  vUSDT: '0xfD5840Cd36d94D7229439859C0112a4185BC0255',
  vBNB: '0xA07c5b74C9B40447a954e1466938b865b6BBea36',
} as const;

export const PANCAKESWAP_V3 = {
  positionManager: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
  factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
} as const;

export const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

export const VTOKEN_ABI = parseAbi([
  'function mint(uint256 mintAmount) returns (uint256)',
  'function borrow(uint256 borrowAmount) returns (uint256)',
  'function balanceOfUnderlying(address owner) returns (uint256)',
  'function borrowBalanceCurrent(address account) returns (uint256)',
  'function exchangeRateStored() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function borrowBalanceStored(address account) view returns (uint256)',
]);

export const COMPTROLLER_ABI = parseAbi([
  'function enterMarkets(address[] vTokens) returns (uint256[])',
  'function markets(address) view returns (bool isListed, uint256 collateralFactorMantissa, bool isVenus)',
  'function getAccountLiquidity(address) view returns (uint256, uint256, uint256)',
]);

export const PCS_POSITION_MANAGER_ABI = parseAbi([
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
]);

export const PCS_FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
]);

export const PCS_POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)',
  'function tickSpacing() view returns (int24)',
]);
