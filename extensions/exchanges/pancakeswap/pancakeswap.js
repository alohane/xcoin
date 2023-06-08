"use strict";

//  ---------------------------------------------------------------------------

const ccxt = require("ccxt");
const Exchange = ccxt.Exchange;
const ExchangeError = ccxt.ExchangeError;
const { Swapper } = require("./defi/Swapper");
const {
  ApolloClient,
  InMemoryCache,
  useQuery,
  gql,
  HttpLink,
} = require("@apollo/client");
const { fetch } = require("cross-fetch");
const {
  getProducts,
  getTokenPool,
  getPool,
  getToken,
  getPools,
  getPoolHourData,
  getTokenExtraInfo,
  getPairArrayDaylyData,
} = require("./defi/PanQuery3");
const tb = require("timebucket");
const readline = require("readline");
module.exports = class pancakeswap extends Exchange {
  describe() {
    return this.deepExtend(super.describe(), {
      id: "pancakeswap",
      name: "pancakeswap",
      defi: true,
      rateLimit: 10000,
      version: "v1",
      countries: ["US"],
      has: {
        cancelOrder: false,
        CORS: true,
        createLimitOrder: false,
        createMarketOrder: false,
        createOrder: true,
        editOrder: false,
        privateAPI: false,
        fetchBalance: true,
        fetchCurrencies: true,
        fetchL2OrderBook: false,
        fetchMarkets: true,
        fetchOHLCV: true,
        fetchOrderBook: false,
        fetchTicker: true,
        fetchTickers: true,
        fetchTrades: true,
      },
      urls: {
        logo: "https://user-images.githubusercontent.com/51840849/87182086-1cd4cd00-c2ec-11ea-9ec4-d0cf2a2abf62.jpg",
        api: {
          bscscan: "https://api.bscscan.com/api",
          public: "https://api.pancakeswap.com",
          files: "https://files.pancakeswap.com",
          charts: "https://graph.pancakeswap.com",
        },
        www: "https://pancakeswap.com",
        doc: "https://pancakeswap.com/api",
      },
      requiredCredentials: {
        apiKey: false,
        secret: false,
      },
      api: {
        files: {
          get: ["generated/stats/global.json"],
        },
        graphs: {
          get: ["currencies/{name}/"],
        },
        public: {
          get: ["ticker/", "ticker/{id}/", "global/"],
        },
      },
    });
  }
  constructor(userConfig = {}) {
    super(userConfig);
    this.swapper = new Swapper(this.options);
    this.baseTokenAddress = this.options.address.wbnb.toLowerCase();
    this.apolloClient = new ApolloClient({
      link: new HttpLink({ uri: this.options.graphql3, fetch }),
      cache: new InMemoryCache(),
      shouldBatch: true,
    });
  }
  async fetchOrderBook(symbol, limit = undefined, params = {}) {
    throw new ExchangeError(
      "Fetching order books is not supported by the API of " + this.id
    );
  }
  async fetchToken(opts, params = {}) {
    let res;
    console.log("opts", opts);
    res = await getToken(
      this.apolloClient,
      opts.token,
      this.options.api.bscscan,
      true,
      true
    );
    console.log("fetchToken ok", res);
    return res;
  }
  async fetchMarkets(opts, params = {}) {
    let products = [];
    try {
      products = require(`../../../data/exchanges/pancakeswap_products.json`);
    } catch (e) {}
    let blacklist = [];
    try {
      blacklist = require(`../../../data/exchanges/pancakeswap_blacklist.json`);
    } catch (e) {}
    console.log("products", products.length, "blacklist", blacklist.length);
    let newTokenList = [];
    let since = opts.since || 1;
    let baseTokenAddress = opts.baseTokenAddress || this.baseTokenAddress;
    let minHolders = opts.minHolders || 1000;
    let maxHolders = opts.maxHolders || 50000;
    let limit = opts.limit || 1000;
    let minVolumeUSD = opts.minVolumeUSD || 100000;
    let maxVolumeUSD = opts.maxVolumeUSD || 50000000;
    let minTotalTransactions = opts.minTotalTransactions || 1000;
    //  console.log('fetchMarkets', baseTokenAddress, since, minHolders, limit, minVolumeUSD, minReserveUSD, minTotalTransactions)
    if (since) {
      const query_start = tb().resize("1d").subtract(since).toMilliseconds();
      // console.log('init since..', (new Date()).getTime(), since, query_start)
      since = query_start / 1000;
    }
    let tokens = await getProducts(
      this.apolloClient,
      "new",
      baseTokenAddress,
      since,
      limit,
      minVolumeUSD,
      maxVolumeUSD,
      minTotalTransactions
    );
    console.log("fetchMarkets get tokens ok", tokens.length);
    tokens = tokens.filter(
      (t) =>
        t.token.txCount >= minTotalTransactions &&
        t.token.volumeUSD >= minVolumeUSD &&
        t.token.volumeUSD <= maxVolumeUSD
    );
    // console.log("fetchMarkets filter tokens ok", tokens.length);
    for (let i = 0; i < tokens.length; i++) {
      let token = tokens[i];
      let black = blacklist.find((t) => t.base === token.token.id);
      if (black) continue;
      let find = products.find((t) => t.asset === token.token.id);
      if (find) continue;
      let symbol = {
        base: token.token.id,
        quote: this.baseTokenAddress,
        active: true,
        decimals: token.token.decimals,
        price: token.priceUSD,
        volumeUSD: token.token.volumeUSD,
        txCount: token.token.txCount,
      };
      try {
        symbol = await getTokenExtraInfo(
          null,
          symbol,
          this.options.api.bscscan
        );
      } catch (e) {
        console.log("getTokenExtraInfo error", e);
      }
      if (
        !symbol.holders ||
        (symbol.holders &&
          symbol.holders >= minHolders &&
          symbol.holders <= maxHolders)
      ) {
        let tokenPool = await getTokenPool(
          this.apolloClient,
          baseTokenAddress,
          symbol.base
        );
        //  console.log("tokenpool", tokenPool.whitelistPools);
        if (tokenPool.whitelistPools.length) {
          let fitPool = tokenPool.whitelistPools.find(
            (w) =>
              w.token0.id === baseTokenAddress ||
              w.token1.id === baseTokenAddress
          );
          // console.log("fitPool", fitPool);
          if (fitPool) {
            Object.assign(symbol, {
              id: fitPool.id,
              name:
                fitPool.token0.id === baseTokenAddress
                  ? fitPool.token1.symbol + "/" + fitPool.token0.symbol
                  : fitPool.token0.symbol + "/" + fitPool.token1.symbol,
              csymbol:
                fitPool.token0.id === baseTokenAddress
                  ? fitPool.token0.symbol
                  : fitPool.token1.symbol,
              price:
                fitPool.token0.id === baseTokenAddress
                  ? fitPool.token0Price
                  : fitPool.token1Price,
            });
            newTokenList.push(symbol);
          }
        }
      } else {
        blacklist.push(symbol);
      }
    }
    console.log("newTokenList ok", newTokenList.length);
    return { newTokenList, blacklist };
  }

  parseTicker(ticker, pairDayData, market = undefined) {
    /* let timestamp = this.safeTimestamp(ticker, 'timestamp');
        if (timestamp === undefined) {
            timestamp = this.milliseconds();
        } */
    let timestamp = this.milliseconds();
    let id = this.safeString(ticker, "id");

    let last =
      ticker.token0.id === this.baseTokenAddress.toLowerCase()
        ? this.safeNumber(ticker, "token0Price")
        : this.safeNumber(ticker, "token1Price");
    let volume = 0;
    // console.log('hourData', hourData)
    let hourVolume = "0";
    let dayVolume = "0";
    //  console.log('pairDayData', pairDayData, dayVolume)
    return {
      symbol: id,
      timestamp: timestamp,
      datetime: this.iso8601(timestamp),
      high: last,
      low: last,
      bid: last,
      bidVolume: undefined,
      ask: last,
      askVolume: undefined,
      vwap: undefined,
      open: undefined,
      close: last,
      last: last,
      previousClose: undefined,
      change: undefined,
      percentage: undefined,
      average: undefined,
      baseVolume: volume,
      quoteVolume: volume * last,
      dayVolume: dayVolume,
      hourVolume: hourVolume,
      info: ticker,
    };
  }
  sign(
    path,
    api = "public",
    method = "GET",
    params = {},
    headers = undefined,
    body = undefined
  ) {
    let url;
    if (api === "bscscan") {
      url = this.urls["api"][api] + "/" + this.implodeParams(path, params);
    } else {
      url =
        this.urls["api"][api] +
        "/" +
        this.version +
        "/" +
        this.implodeParams(path, params);
    }
    const query = this.omit(params, this.extractParams(path));
    if (Object.keys(query).length) {
      url += "?" + this.urlencode(query);
    }
    console.log("url", url);
    return { url: url, method: method, body: body, headers: headers };
  }

  async request(
    path,
    api = "public",
    method = "GET",
    params = {},
    headers = undefined,
    body = undefined
  ) {
    const response = await this.fetch2(
      path,
      api,
      method,
      params,
      headers,
      body
    );
    if ("error" in response) {
      if (response["error"]) {
        throw new ExchangeError(this.id + " " + this.json(response));
      }
    }
    return response;
  }
  async fetchBalance(tokens = null, params = {}) {
    const balance = await this.swapper.getBalances(tokens, params);
    return balance;
  }
  async fetchOrder(id, params = {}) {
    const request = {
      txhash: id,
      apiKey: this.apiKey,
      module: "transaction",
      action: "gettxreceiptstatus",
      req_time: this.seconds(),
    };
    const response = await this.request(
      "",
      "bscscan",
      "GET",
      this.extend(request, params)
    );
    // console.log('response', response)
    let status = this.safeString(response.result && response.result, "status");
    return {
      id: id,
      status: status === "1" ? "done" : status === "0" ? "rejected" : "open",
      info: response,
    };
  }
  parseOrder(response) {
    // Different API endpoints returns order info in different format...
    // with different fields filled.
    return {
      id: response.hash,
      status: response.hash ? "open" : "canceled",
      size: response.size || null,
      price: response.price || null,
      info: response,
    };
  }
  async createOrder(
    product,
    type,
    side,
    amount,
    price = undefined,
    slippage = undefined,
    params = {}
  ) {
    if (type === "market") {
      throw new ExchangeError(this.id + " allows limit orders only");
    }
    try {
      amount = parseFloat(amount).toFixed(6);
      if (amount <= 0) {
        throw new ExchangeError("INSUFFICIENT_FUNDS");
        return;
      }
      if (side === "sell") {
        await this.swapper.init(product, true);
      } else {
        await this.swapper.init(product);
      }
      const trade = await this.swapper.GetTrade(amount, slippage);
      if (!trade) {
        throw new ExchangeError("GetBuyTradeError");
        return;
      }
      // console.log('trade', trade)
      const response = await this.swapper.execSwap(trade.inputAmount, trade);
      // console.log('response', response)
      return this.parseOrder(
        this.extend(
          {
            status: "open",
            type: side,
            size: trade.inputAmount.toSignificant(6),
            price: trade.executionPrice.invert().toSignificant(6),
            initialAmount: amount,
          },
          response
        )
      );
    } catch (error) {
      console.error("createOrder Error", error);
      throw new ExchangeError(error.code || error.message || error.body);
    }
  }
  async fetchTicker(product, params = {}) {
    //  console.log('fetchTicker', product)
    let response = await getPool(this.apolloClient, product.id);
    let last =
      response.token0.id === this.baseTokenAddress.toLowerCase()
        ? this.safeNumber(response, "token0Price")
        : this.safeNumber(response, "token1Price");
    return {
      bid: last,
      ask: last,
      dayVolume: 0,
    };
  }
  async fetchPool(product, params = {}) {
    // console.log('fetchPool', tokens)
    let pair = await getPool(
      this.apolloClient,
      product.id,
      product.asset.toLowerCase(),
      product.currency.toLowerCase()
    );
    return pair;
  }
  async fetchPairs(pairAddressArray, params = {}) {
    // console.log('fetchPair', tokens)
    //    pairAddressArray = ['0xea26b78255df2bbc31c1ebf60010d78670185bd0', '0x37908620def1491dd591b5a2d16022a33cdda415']
    let res = await getPairArrayDaylyData(
      this.apolloClient,
      pairAddressArray,
      0,
      5,
      0
    );
    console.log("getPairDaylyData", res.data.pairDayDatas);
    return res;
  }
  async fetchTickers(symbols, limit = 1000, params = {}) {
    symbols = symbols.map((s) => s.id);
    const response = await getPools(this.apolloClient, symbols, limit);
    // console.log("response", response);
    const result = {};
    for (let t = 0; t < response.length; t++) {
      const ticker = response[t];
      const label =
        ticker.token0.id === this.baseTokenAddress.toLowerCase()
          ? ticker.token1.id.toLowerCase() +
            "/" +
            ticker.token0.id.toLowerCase()
          : ticker.token0.id.toLowerCase() +
            "/" +
            ticker.token1.id.toLowerCase();
      result[label] = this.parseTicker(ticker);
      console.log("result", result[label].bid);
    }

    return result;
  }
  async fetchTrades(opts, params = {}) {
    const defaultLimit = 100;
    const maxLimit = 500; //1619136000 1628208000000
    let limit =
      opts.limit === undefined ? defaultLimit : Math.min(opts.limit, maxLimit);
    const since = parseInt(opts.from / 1000);
    // console.log('fetchTrades', since, limit)
    let response = await getPairHourData(
      this.apolloClient,
      opts.id,
      since,
      limit,
      0
    );
    // console.log('getPairHourData', response)
    const data = this.safeValue(response, "data", {});
    let pairHourDatas = this.safeValue(data, "pairHourDatas", {});
    // console.log('pairHourDatas', pairHourDatas[0], pairHourDatas.length)
    return this.parseTrades(pairHourDatas, undefined, since, limit);
    /* const result = {};
        for (let t = 0; t < pairHourDatas.length; t++) {
            const ticker = pairHourDatas[t];
            const symbolLabel = symbol.asset + '/' + symbol.currency;
            result[symbolLabel] = this.parseTicker(ticker);
        }
        return result; */
  }
  parseTrade(trade, market = undefined) {
    //console.log('trade', trade)
    const timestamp = this.safeTimestamp(trade, "hourStartUnix");
    const price =
      trade.pair.token0.id === this.baseTokenAddress.toLowerCase()
        ? this.safeNumber(trade, "reserve0") /
          this.safeNumber(trade, "reserve1")
        : this.safeNumber(trade, "reserve1") /
          this.safeNumber(trade, "reserve0");
    // const priceString = this.safeNumber(trade, 'reserve1') / this.safeNumber(trade, 'reserve0');
    const amountString = this.safeString(trade, "hourlyVolumeUSD");
    //  const price = this.parseNumber(priceString);
    // console.log('priceString', price, typeof price, this.fromWei(price), this.toWei(price), this.numberToString(price))
    const amount = this.parseNumber(amountString);
    return {
      id: "t" + timestamp,
      timestamp: timestamp,
      datetime: this.iso8601(timestamp),
      type: undefined,
      price: this.numberToString(price),
      amount: amount,
      info: trade,
    };
  }
  async fetchOHLCV(opts, params = {}) {
    const defaultLimit = 100;
    const maxLimit = 1000; //1619136000 1628208000000
    let limit =
      opts.limit === undefined ? defaultLimit : Math.min(opts.limit, maxLimit);
    const since = parseInt(opts.from / 1000);
    let response = await getPoolHourData(
      this.apolloClient,
      opts.id,
      since,
      limit,
      0
    );
    // console.log("getPoolHourData", response);
    const data = this.safeValue(response, "data", {});
    const data2 = this.safeValue(data, "pool", {});
    let pairHourDatas = this.safeValue(data2, "poolHourData", {});
    console.log("pairHourDatas", pairHourDatas[0], pairHourDatas.length);
    return this.parseOHLCVs(pairHourDatas, undefined, since, limit);
  }
  parseOHLCV(ohlcv) {
    return [
      this.safeTimestamp(ohlcv, "periodStartUnix"),
      this.safeNumber(ohlcv, "open"),
      this.safeNumber(ohlcv, "high"),
      this.safeNumber(ohlcv, "low"),
      this.safeNumber(ohlcv, "close"),
      this.safeNumber(ohlcv, "volumeUSD"),
    ];
  }
};
