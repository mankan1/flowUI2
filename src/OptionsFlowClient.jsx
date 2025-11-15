import React, {
  useState,
  useEffect,
  useRef,
  useCallback
} from 'react';
import {
  TrendingUp,
  TrendingDown,
  Zap,
  Activity,
  AlertCircle
} from 'lucide-react';

const WS_URL = 'ws://localhost:3000/ws';

const OptionsFlowClient = () => {
  const [connected, setConnected] = useState(false);
  const [activeTab, setActiveTab] = useState('stream');

  const [trades, setTrades] = useState([]);          // CALL/PUT summary trades
  const [prints, setPrints] = useState([]);          // individual prints
  const [quotes, setQuotes] = useState({});          // option quotes (by conid)
  const [ulQuotes, setUlQuotes] = useState({});      // underlying quotes (by conid)
  const [conidMapping, setConidMapping] = useState({}); // conid → { symbol, right, strike, expiry, type, ... }
  const [stats, setStats] = useState(null);          // TRADING_STATS payload
  const [autoTrades, setAutoTrades] = useState([]);  // subset of trades flagged as auto

  const [filters, setFilters] = useState({
    symbol: '',
    minPremium: 0,
    direction: 'all',
    classification: 'all',
    stance: 'all'
  });

  const wsRef = useRef(null);

  const streamCount = trades.length;
  const printCount = prints.length;
  const quoteCount = Object.keys(quotes).length + Object.keys(ulQuotes).length;
  const autoCount = autoTrades.length;

  /* ========================= WS HANDLER ========================= */

  const connectWebSocket = useCallback(() => {
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      setConnected(true);
      console.log('✅ Connected to Options Flow');

      ws.send(
        JSON.stringify({
          action: 'subscribe',
          futuresSymbols: ['/ES', '/NQ'],
          equitySymbols: ['SPY', 'QQQ', 'AAPL', 'TSLA']
        })
      );
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case 'CONID_MAPPING': {
          setConidMapping((prev) => ({
            ...prev,
            [data.conid]: data.mapping
          }));
          break;
        }

        case 'CALL':
        case 'PUT': {
          const enriched = {
            ...data,
            receivedAt: Date.now(),
            initialPrice: data.optionPrice,
            currentPrice: data.optionPrice,
            priceChange: 0,
            priceChangePct: 0
          };

          setTrades((prev) => [enriched, ...prev].slice(0, 200));

          if (data.isAutoTrade) {
            setAutoTrades((prev) => [enriched, ...prev].slice(0, 50));
          }
          break;
        }

        case 'PRINT': {
          setPrints((prev) => [data, ...prev].slice(0, 200));
          break;
        }

        case 'LIVE_QUOTE': {
          // Option quote
          setQuotes((prev) => ({
            ...prev,
            [data.conid]: data
          }));

          // Update trades for that conid with new price / P&L
          setTrades((prev) =>
            prev.map((t) => {
              if (t.conid !== data.conid) return t;
              const last = data.last ?? t.currentPrice ?? t.optionPrice;
              const priceChange = last - t.initialPrice;
              const priceChangePct =
                t.initialPrice ? (priceChange / t.initialPrice) * 100 : 0;
              return {
                ...t,
                currentPrice: last,
                priceChange,
                priceChangePct
              };
            })
          );

          // Also update autoTrades mirror
          setAutoTrades((prev) =>
            prev.map((t) => {
              if (t.conid !== data.conid) return t;
              const last = data.last ?? t.currentPrice ?? t.optionPrice;
              const priceChange = last - t.initialPrice;
              const priceChangePct =
                t.initialPrice ? (priceChange / t.initialPrice) * 100 : 0;
              return {
                ...t,
                currentPrice: last,
                priceChange,
                priceChangePct
              };
            })
          );

          break;
        }

        case 'UL_LIVE_QUOTE': {
          setUlQuotes((prev) => ({
            ...prev,
            [data.conid]: data
          }));
          break;
        }

        case 'TRADING_STATS': {
          setStats(data.stats);
          break;
        }

        default:
          break;
      }
    };

    ws.onclose = () => {
      setConnected(false);
      console.log('❌ Disconnected from Options Flow – retrying in 3s');
      setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = () => {
      setConnected(false);
    };

    wsRef.current = ws;
  }, []);

  useEffect(() => {
    connectWebSocket();
    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, [connectWebSocket]);

  /* ========================= HELPERS ========================= */

  const getMapping = (conid) => {
    return conidMapping[conid] || { symbol: 'Unknown', type: 'OPT' };
  };

  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    const d = new Date(timestamp);
    return d.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  const safeToFixed = (value, digits = 2, fallback = 'N/A') => {
    if (value === null || value === undefined || Number.isNaN(value)) {
      return fallback;
    }
    return Number(value).toFixed(digits);
  };

  const formatPremium = (premium = 0) => {
    if (premium >= 1_000_000) return `$${(premium / 1_000_000).toFixed(2)}M`;
    if (premium >= 1_000) return `$${(premium / 1_000).toFixed(0)}k`;
    return `$${premium.toFixed(0)}`;
  };

  const getStanceColor = (stanceLabel) => {
    if (stanceLabel === 'BULL') return 'text-green-400';
    if (stanceLabel === 'BEAR') return 'text-red-400';
    return 'text-yellow-400';
  };

  const getStanceBg = (stanceLabel) => {
    if (stanceLabel === 'BULL') return 'bg-green-900/30 border-green-500';
    if (stanceLabel === 'BEAR') return 'bg-red-900/30 border-red-500';
    return 'bg-yellow-900/30 border-yellow-500';
  };

  const getClassificationBadges = (classifications) => {
    if (!classifications || !classifications.length) return null;
    return classifications.map((cls) => {
      let bg = 'bg-gray-700';
      if (cls === 'SWEEP') bg = 'bg-red-600';
      else if (cls === 'BLOCK') bg = 'bg-orange-600';
      else if (cls === 'NOTABLE') bg = 'bg-green-600';
      return (
        <span
          key={cls}
          className={`px-2 py-1 text-xs font-bold rounded ${bg}`}
        >
          {cls}
        </span>
      );
    });
  };

  const getDirectionStyle = (direction) => {
    const styles = {
      BTO: 'bg-green-700 text-white',
      STO: 'bg-orange-700 text-white',
      BTC: 'bg-cyan-700 text-white',
      STC: 'bg-purple-700 text-white'
    };
    return styles[direction] || 'bg-gray-700 text-white';
  };

  const getCurrentULPrice = (ulConid) => {
    const q = ulQuotes[ulConid];
    return q ? q.last : undefined;
  };

  const calculatePnL = (trade) => {
    const entry = trade.optionPrice ?? trade.initialPrice ?? 0;
    const current = trade.currentPrice ?? entry;
    const contracts = trade.size || 1;
    const multiplier = trade.multiplier || 100;

    if (!entry) {
      return { dollarPnL: 0, percentPnL: 0 };
    }

    const priceDiff = current - entry;
    const dollarPnL = priceDiff * contracts * multiplier;
    const percentPnL = (priceDiff / entry) * 100;

    return { dollarPnL, percentPnL };
  };

  /* ========================= FILTERED DATA ========================= */

  const filteredTrades = trades.filter((trade) => {
    if (
      filters.symbol &&
      !trade.symbol?.toUpperCase().includes(filters.symbol.toUpperCase())
    ) {
      return false;
    }
    if (filters.minPremium && trade.premium < filters.minPremium) return false;
    if (filters.direction !== 'all' && trade.direction !== filters.direction)
      return false;
    if (
      filters.classification !== 'all' &&
      !trade.classifications?.includes(filters.classification)
    ) {
      return false;
    }
    if (filters.stance !== 'all' && trade.stanceLabel !== filters.stance)
      return false;
    return true;
  });

  /* ========================= RENDER ========================= */

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-4">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div
              className={`w-3 h-3 rounded-full ${
                connected ? 'bg-green-500 animate-pulse' : 'bg-red-500'
              }`}
            />
            <h1 className="text-3xl font-bold">Options Flow Monitor</h1>
            <span className="text-sm text-gray-400">{WS_URL}</span>
          </div>

          <div className="flex items-center gap-2 text-sm">
            <span className="px-3 py-1 bg-gray-800 rounded">
              Connected to IBKR Flow
            </span>
          </div>
        </div>

        <div className="text-sm text-gray-400 mb-4">
          Equities + Futures • ~25 ATM strikes • ~15 DTE • Live quotes, prints
          &amp; BTO/STO/BTC/STC classifications
        </div>

        {/* Quick symbol buttons (just set symbol filter for now) */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <div className="text-xs text-gray-500 mb-2">Futures:</div>
            <div className="flex flex-wrap gap-2">
              {['/ES', '/NQ', '/YM', '/RTY', '/CL', '/GC'].map((sym) => (
                <button
                  key={sym}
                  className="px-4 py-2 bg-gray-800 hover:bg-cyan-700 rounded font-semibold transition-colors text-sm"
                  onClick={() =>
                    setFilters((prev) => ({ ...prev, symbol: sym }))
                  }
                >
                  {sym}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs text-gray-500 mb-2">Equities:</div>
            <div className="flex flex-wrap gap-2">
              {['SPY', 'QQQ', 'AAPL', 'TSLA', 'NVDA', 'AMZN', 'MSFT', 'META', 'GOOGL'].map(
                (sym) => (
                  <button
                    key={sym}
                    className="px-4 py-2 bg-gray-800 hover:bg-purple-700 rounded font-semibold transition-colors text-sm"
                    onClick={() =>
                      setFilters((prev) => ({ ...prev, symbol: sym }))
                    }
                  >
                    {sym}
                  </button>
                )
              )}
            </div>
          </div>
        </div>

        {/* (Placeholder) Pause / Auto-scroll controls */}
        <div className="flex gap-4 mb-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="w-4 h-4" />
            Pause
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="w-4 h-4" defaultChecked />
            Auto-scroll
          </label>
        </div>

        {/* Tabs */}
        <div className="flex flex-wrap gap-2 mb-4">
          {[
            ['stream', `Stream ${streamCount}`],
            ['trades', `Trades ${streamCount}`],
            ['prints', `Prints ${printCount}`],
            ['quotes', `Quotes ${quoteCount}`],
            ['auto', `Auto ${autoCount}`],
            ['stats', 'Stats']
          ].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`px-6 py-2 rounded-lg font-semibold text-sm transition-all ${
                activeTab === key
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3 bg-gray-900 p-4 rounded-lg border border-gray-800">
          <input
            type="text"
            placeholder="Symbol filter (e.g., NVDA)"
            value={filters.symbol}
            onChange={(e) =>
              setFilters((prev) => ({ ...prev, symbol: e.target.value }))
            }
            className="px-4 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-blue-500 text-sm"
          />

          <select
            value={filters.direction}
            onChange={(e) =>
              setFilters((prev) => ({ ...prev, direction: e.target.value }))
            }
            className="px-4 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-blue-500 text-sm"
          >
            <option value="all">Any direction</option>
            <option value="BTO">BTO</option>
            <option value="STO">STO</option>
            <option value="BTC">BTC</option>
            <option value="STC">STC</option>
          </select>

          <select
            value={filters.classification}
            onChange={(e) =>
              setFilters((prev) => ({
                ...prev,
                classification: e.target.value
              }))
            }
            className="px-4 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-blue-500 text-sm"
          >
            <option value="all">All classifications</option>
            <option value="SWEEP">Sweeps</option>
            <option value="BLOCK">Blocks</option>
            <option value="NOTABLE">Notables</option>
          </select>

          <select
            value={filters.stance}
            onChange={(e) =>
              setFilters((prev) => ({ ...prev, stance: e.target.value }))
            }
            className="px-4 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-blue-500 text-sm"
          >
            <option value="all">All stances</option>
            <option value="BULL">Bull</option>
            <option value="BEAR">Bear</option>
            <option value="NEUTRAL">Neutral</option>
          </select>

          <input
            type="number"
            placeholder="Min Premium ≥ 0"
            value={filters.minPremium}
            onChange={(e) =>
              setFilters((prev) => ({
                ...prev,
                minPremium: Number(e.target.value) || 0
              }))
            }
            className="px-4 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-blue-500 text-sm"
          />
        </div>
      </div>

      {/* STREAM / TRADES TAB */}
      {(activeTab === 'stream' || activeTab === 'trades') && (
        <div className="space-y-3">
          {filteredTrades.map((trade, idx) => {
            const quote = quotes[trade.conid] || {};
            const ulMapping = getMapping(trade.underlyingConid);
            const currentUL = getCurrentULPrice(trade.underlyingConid);
            const baseUL = trade.underlyingPrice;
            const ulPct =
              currentUL && baseUL
                ? ((currentUL - baseUL) / baseUL) * 100
                : 0;

            const { dollarPnL, percentPnL } = calculatePnL(trade);
            const pnlColor =
              dollarPnL >= 0 ? 'text-green-400' : 'text-red-400';

            const dte = trade.dte ?? trade.daysToExpiry;
            const moneynessPct =
              trade.moneyness != null ? trade.moneyness * 100 : null;

            return (
              <div
                key={`${trade.conid}-${trade.timestamp}-${idx}`}
                className={`p-4 rounded-lg border-2 ${
                  trade.classifications?.includes('SWEEP')
                    ? 'bg-red-900/20 border-red-500'
                    : trade.classifications?.includes('BLOCK')
                    ? 'bg-orange-900/20 border-orange-500'
                    : trade.classifications?.includes('NOTABLE')
                    ? 'bg-green-900/20 border-green-500'
                    : 'bg-gray-900 border-gray-800'
                }`}
              >
                {/* Header row */}
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    {getClassificationBadges(trade.classifications)}

                    <span
                      className={`px-2 py-1 text-xs font-bold rounded ${getDirectionStyle(
                        trade.direction
                      )}`}
                    >
                      {trade.direction || 'UNK'}
                    </span>

                    <div
                      className={`flex items-center gap-1 px-2 py-1 rounded border ${getStanceBg(
                        trade.stanceLabel
                      )}`}
                    >
                      {trade.stanceLabel === 'BULL' ? (
                        <TrendingUp className="w-4 h-4" />
                      ) : trade.stanceLabel === 'BEAR' ? (
                        <TrendingDown className="w-4 h-4" />
                      ) : (
                        <Activity className="w-4 h-4" />
                      )}
                      <span
                        className={`font-bold text-sm ${getStanceColor(
                          trade.stanceLabel
                        )}`}
                      >
                        {trade.stanceLabel || 'NEUTRAL'}
                      </span>
                      {trade.stanceScore !== undefined && (
                        <span className="text-xs text-gray-400">
                          ({trade.stanceScore})
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-1 px-2 py-1 bg-yellow-900/30 rounded border border-yellow-600">
                      <Zap className="w-4 h-4 text-yellow-400" />
                      <span className="font-semibold text-sm text-yellow-400">
                        {trade.confidence ?? 0}%
                      </span>
                    </div>

                    <span className="px-2 py-1 text-xs bg-gray-800 rounded">
                      {trade.assetClass === 'FUTURES_OPTION'
                        ? '📊 FUT'
                        : '📈 EQ'}
                    </span>

                    <span className="text-xs text-gray-400">
                      {formatTime(trade.timestamp || trade.receivedAt)}
                    </span>
                  </div>
                </div>

                {/* Main info row */}
                <div className="grid grid-cols-2 gap-4 mb-3">
                  <div>
                    <div className="text-2xl font-bold mb-1">
                      {trade.symbol} {trade.type} ${trade.strike}
                    </div>
                    <div className="text-xs text-gray-400 space-y-1">
                      <div>
                        exp {trade.expiry}{' '}
                        {dte !== undefined && <>• DTE {dte}</>}
                      </div>
                      {moneynessPct !== null && (
                        <div>Moneyness: {safeToFixed(moneynessPct, 2)}%</div>
                      )}
                      <div className="flex items-center gap-2">
                        <span>
                          UL:{' '}
                          {ulMapping.symbol ||
                            trade.underlyingSymbol ||
                            trade.symbol}
                        </span>
                        <span className="font-semibold">
                          $
                          {safeToFixed(
                            currentUL || baseUL,
                            2,
                            baseUL ? baseUL.toFixed(2) : '--'
                          )}
                        </span>
                        {currentUL && baseUL && (
                          <span
                            className={`text-xs ${
                              ulPct >= 0
                                ? 'text-green-400'
                                : 'text-red-400'
                            }`}
                          >
                            ({ulPct >= 0 ? '+' : ''}
                            {safeToFixed(Math.abs(ulPct), 2)}%)
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="text-right">
                    <div className="text-3xl font-bold text-green-400 mb-1">
                      {formatPremium(trade.premium || 0)}
                    </div>
                    <div className="text-sm text-gray-400 space-y-1">
                      <div>
                        {trade.size || 0} contracts @ $
                        {safeToFixed(trade.optionPrice, 2, '--')}
                      </div>
                      {trade.currentPrice !== undefined && (
                        <>
                          <div>
                            Now: $
                            {safeToFixed(trade.currentPrice, 2, '--')}
                          </div>
                          <div className={`font-semibold ${pnlColor}`}>
                            P&amp;L:{' '}
                            {percentPnL >= 0 ? '+' : ''}
                            {safeToFixed(percentPnL, 1)}% (
                            {dollarPnL >= 0 ? '+' : '-'}$
                            {safeToFixed(Math.abs(dollarPnL), 0)})
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* Metrics row */}
                <div className="grid grid-cols-7 gap-3 text-sm mb-3">
                  <div>
                    <div className="text-gray-500 text-xs">Delta</div>
                    <div className="font-semibold text-blue-400">
                      {safeToFixed(
                        trade.greeks?.delta,
                        3,
                        'N/A'
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="text-gray-500 text-xs">IV</div>
                    <div className="font-semibold text-purple-400">
                      {trade.greeks?.iv !== undefined
                        ? `${safeToFixed(trade.greeks.iv, 1)}%`
                        : 'N/A'}
                    </div>
                  </div>
                  <div>
                    <div className="text-gray-500 text-xs">Vol/OI</div>
                    <div className="font-semibold text-yellow-400">
                      {safeToFixed(trade.volOiRatio, 2, 'N/A')}
                    </div>
                  </div>
                  <div>
                    <div className="text-gray-500 text-xs">OI</div>
                    <div className="font-semibold">
                      {trade.openInterest?.toLocaleString?.() ??
                        'N/A'}
                    </div>
                  </div>
                  <div>
                    <div className="text-gray-500 text-xs">Vol</div>
                    <div className="font-semibold">
                      {trade.size ?? 'N/A'}
                    </div>
                  </div>
                  <div>
                    <div className="text-gray-500 text-xs">Bid/Ask</div>
                    <div className="font-semibold text-xs">
                      {quote.bid != null
                        ? safeToFixed(quote.bid, 2)
                        : '--'}
                      /
                      {quote.ask != null
                        ? safeToFixed(quote.ask, 2)
                        : '--'}
                    </div>
                  </div>
                  <div>
                    <div className="text-gray-500 text-xs">Aggressor</div>
                    <div
                      className={`font-semibold ${
                        trade.aggressor
                          ? 'text-green-400'
                          : 'text-red-400'
                      }`}
                    >
                      {trade.aggressor === true
                        ? 'BUY'
                        : trade.aggressor === false
                        ? 'SELL'
                        : 'N/A'}
                    </div>
                  </div>
                </div>

                {/* Historical comparison */}
                {trade.historicalComparison && (
                  <div className="bg-gray-950 p-3 rounded border border-gray-800">
                    <div className="text-xs text-gray-500 mb-2">
                      Historical Comparison (12d avg)
                    </div>
                    <div className="grid grid-cols-5 gap-3 text-xs">
                      <div>
                        <div className="text-gray-500">Avg OI</div>
                        <div className="font-semibold">
                          {trade.historicalComparison.avgOI?.toLocaleString?.() ??
                            'N/A'}
                        </div>
                      </div>
                      <div>
                        <div className="text-gray-500">Avg Vol</div>
                        <div className="font-semibold">
                          {trade.historicalComparison.avgVolume?.toLocaleString?.() ??
                            'N/A'}
                        </div>
                      </div>
                      <div>
                        <div className="text-gray-500">OI Δ</div>
                        <div
                          className={`font-semibold ${
                            (trade.historicalComparison.oiChange || 0) >
                            0
                              ? 'text-green-400'
                              : 'text-red-400'
                          }`}
                        >
                          {trade.historicalComparison.oiChange > 0
                            ? '+'
                            : ''}
                          {trade.historicalComparison.oiChange ??
                            0}
                        </div>
                      </div>
                      <div>
                        <div className="text-gray-500">Vol Multiple</div>
                        <div
                          className={`font-semibold ${
                            (trade.historicalComparison.volumeMultiple ||
                              0) > 2
                              ? 'text-yellow-400'
                              : ''
                          }`}
                        >
                          {safeToFixed(
                            trade.historicalComparison.volumeMultiple,
                            2,
                            'N/A'
                          )}
                          x
                        </div>
                      </div>
                      <div>
                        <div className="text-gray-500">Data Points</div>
                        <div className="font-semibold">
                          {trade.historicalComparison.dataPoints ??
                            'N/A'}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {trade.stanceReasons?.length > 0 && (
                  <div className="mt-2 text-xs text-gray-500">
                    {trade.stanceReasons.join(' • ')}
                  </div>
                )}
              </div>
            );
          })}

          {filteredTrades.length === 0 && (
            <div className="text-center py-12 text-gray-500">
              No trades yet. Waiting for options flow...
            </div>
          )}
        </div>
      )}

      {/* PRINTS TAB */}
      {activeTab === 'prints' && (
        <div className="space-y-2">
          {prints.map((print, idx) => {
            const stanceColor =
              print.stance === 'BULL'
                ? 'text-green-400'
                : print.stance === 'BEAR'
                ? 'text-red-400'
                : 'text-yellow-400';

            return (
              <div
                key={`${print.conid}-${print.timestamp}-${idx}`}
                className="p-3 bg-gray-900 rounded-lg border border-cyan-700"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="px-2 py-1 bg-cyan-900 text-cyan-300 text-xs font-bold rounded">
                      PRINT
                    </span>

                    {print.stance && (
                      <span
                        className={`px-2 py-1 text-xs font-bold rounded border ${
                          print.stance === 'BULL'
                            ? 'bg-green-900/30 border-green-500'
                            : print.stance === 'BEAR'
                            ? 'bg-red-900/30 border-red-500'
                            : 'bg-yellow-900/30 border-yellow-500'
                        }`}
                      >
                        <span className={stanceColor}>
                          {print.stance}
                        </span>
                        {print.stanceScore && ` ${print.stanceScore}`}
                      </span>
                    )}

                    <span className="font-bold text-lg">
                      {print.symbol} {print.right} ${print.strike}
                    </span>
                    <span className="text-gray-400 text-sm">
                      {print.expiry}
                    </span>
                    <span className="text-cyan-400 font-semibold">
                      {print.tradeSize} @ $
                      {safeToFixed(print.tradePrice, 2, '--')}
                    </span>
                    <span className="text-gray-400">
                      {formatPremium(print.premium || 0)}
                    </span>
                    <span className="text-yellow-400 text-sm">
                      Vol/OI:{' '}
                      {safeToFixed(print.volOiRatio, 2, 'N/A')}
                    </span>
                    <span
                      className={`text-sm font-semibold ${
                        print.aggressor ? 'text-green-400' : 'text-red-400'
                      }`}
                    >
                      {print.aggressor ? 'BUY-agg' : 'SELL-agg'}
                    </span>
                  </div>

                  <span className="text-xs text-gray-500">
                    {formatTime(print.timestamp)}
                  </span>
                </div>
              </div>
            );
          })}

          {prints.length === 0 && (
            <div className="text-center py-12 text-gray-500">
              No prints yet. Waiting for print data...
            </div>
          )}
        </div>
      )}

      {/* QUOTES TAB */}
      {activeTab === 'quotes' && (
        <div className="space-y-2">
          {/* Underlyings */}
          {Object.entries(ulQuotes).map(([conid, quote]) => {
            const mapping = getMapping(conid);
            return (
              <div
                key={`ul-${conid}`}
                className="p-3 bg-gray-900 rounded-lg border border-purple-800"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <span className="px-2 py-1 text-xs font-bold rounded bg-purple-900 text-purple-300">
                      UL
                    </span>
                    <div className="font-bold text-xl">
                      {mapping.symbol || `conid ${conid}`}
                    </div>
                    <div className="text-lg font-semibold">
                      last{' '}
                      <span className="text-purple-400">
                        $
                        {safeToFixed(
                          quote.last,
                          2,
                          '--'
                        )}
                      </span>
                    </div>
                    <div className="text-sm text-gray-400">
                      bid $
                      {safeToFixed(quote.bid, 2, '--')}
                    </div>
                    <div className="text-sm text-gray-400">
                      ask $
                      {safeToFixed(quote.ask, 2, '--')}
                    </div>
                    <div className="text-sm text-gray-500">
                      vol {quote.volume ?? 0}
                    </div>
                  </div>
                  <span className="text-xs text-gray-500">
                    {formatTime(quote.timestamp)}
                  </span>
                </div>
              </div>
            );
          })}

          {/* Options */}
          {Object.entries(quotes).map(([conid, quote]) => {
            const mapping = getMapping(conid);
            const isOption = mapping.type !== 'UNDERLYING';

            return (
              <div
                key={`opt-${conid}`}
                className="p-3 bg-gray-900 rounded-lg border border-gray-800"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <span
                      className={`px-2 py-1 text-xs font-bold rounded ${
                        isOption
                          ? 'bg-blue-900 text-blue-300'
                          : 'bg-purple-900 text-purple-300'
                      }`}
                    >
                      {isOption ? 'OPT' : 'UL'}
                    </span>

                    <div>
                      <div className="font-bold text-lg">
                        {mapping.symbol || `conid ${conid}`}
                        {mapping.right && (
                          <span className="ml-2 text-gray-400">
                            {mapping.right === 'C' ? 'CALL' : 'PUT'} $
                            {mapping.strike}
                          </span>
                        )}
                      </div>
                      {mapping.expiry && (
                        <div className="text-xs text-gray-500">
                          exp {mapping.expiry}
                        </div>
                      )}
                    </div>

                    <div className="text-lg font-semibold">
                      last{' '}
                      <span className="text-cyan-400">
                        $
                        {safeToFixed(
                          quote.last,
                          2,
                          '--'
                        )}
                      </span>
                    </div>
                    <div className="text-sm text-gray-400">
                      bid{' '}
                      <span className="text-green-400">
                        $
                        {safeToFixed(
                          quote.bid,
                          2,
                          '--'
                        )}
                      </span>
                    </div>
                    <div className="text-sm text-gray-400">
                      ask{' '}
                      <span className="text-red-400">
                        $
                        {safeToFixed(
                          quote.ask,
                          2,
                          '--'
                        )}
                      </span>
                    </div>

                    {quote.delta !== undefined && (
                      <div className="text-sm">
                        Δ{' '}
                        <span className="text-blue-400 font-semibold">
                          {safeToFixed(quote.delta, 3, 'N/A')}
                        </span>
                      </div>
                    )}

                    <div className="text-sm text-gray-500">
                      vol {quote.volume ?? 0}
                    </div>
                  </div>

                  <span className="text-xs text-gray-500">
                    {formatTime(quote.timestamp)}
                  </span>
                </div>
              </div>
            );
          })}

          {quoteCount === 0 && (
            <div className="text-center py-12 text-gray-500">
              No quotes yet. Waiting for quote data...
            </div>
          )}
        </div>
      )}

      {/* AUTO TAB */}
      {activeTab === 'auto' && (
        <div className="space-y-3">
          {autoTrades.length > 0 ? (
            autoTrades.map((trade, idx) => {
              const { dollarPnL, percentPnL } = calculatePnL(trade);
              const pnlColor =
                dollarPnL >= 0 ? 'text-green-400' : 'text-red-400';

              return (
                <div
                  key={`auto-${idx}`}
                  className="p-4 bg-yellow-900/20 rounded-lg border-2 border-yellow-500"
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <span className="px-3 py-1 bg-yellow-600 text-white font-bold rounded text-xs">
                        AUTO-TRADE
                      </span>
                      <div className="text-2xl font-bold">
                        {trade.symbol} {trade.type} ${trade.strike}
                      </div>
                    </div>

                    <div className="text-right">
                      <div className={`text-2xl font-bold ${pnlColor}`}>
                        {percentPnL >= 0 ? '+' : ''}
                        {safeToFixed(percentPnL, 2)}%
                      </div>
                      <div className={`text-sm ${pnlColor}`}>
                        {dollarPnL >= 0 ? '+' : '-'}$
                        {safeToFixed(Math.abs(dollarPnL), 0)}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-4 gap-4 text-sm">
                    <div>
                      <div className="text-gray-500">Entry</div>
                      <div className="font-semibold">
                        ${safeToFixed(trade.optionPrice, 2, '--')}
                      </div>
                    </div>
                    <div>
                      <div className="text-gray-500">Current</div>
                      <div className="font-semibold text-cyan-400">
                        $
                        {safeToFixed(
                          trade.currentPrice ?? trade.optionPrice,
                          2,
                          '--'
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="text-gray-500">Contracts</div>
                      <div className="font-semibold">
                        {trade.size ?? 0}
                      </div>
                    </div>
                    <div>
                      <div className="text-gray-500">Premium</div>
                      <div className="font-semibold">
                        {formatPremium(trade.premium || 0)}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="text-center py-12 text-gray-500">
              No auto-trades yet.
            </div>
          )}
        </div>
      )}

      {/* STATS TAB */}
      {activeTab === 'stats' && (
        <div className="space-y-4">
          {stats ? (
            <>
              {(() => {
                const daily = stats.daily || {};
                const totalPnL = stats.totalPnL ?? 0;
                const openPositionsCount = stats.openPositionsCount ?? 0;
                const openPnL = stats.openPnL ?? 0;
                const totalTrades = stats.totalTrades ?? 0;

                const winRate =
                  daily.trades > 0
                    ? (daily.wins / daily.trades) * 100
                    : 0;

                return (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                      <div className="bg-gray-900 p-6 rounded-lg border border-gray-800">
                        <div className="text-sm text-gray-500 mb-2">
                          Daily P&amp;L
                        </div>
                        <div
                          className={`text-3xl font-bold ${
                            daily.pnl >= 0
                              ? 'text-green-400'
                              : 'text-red-400'
                          }`}
                        >
                          ${safeToFixed(daily.pnl ?? 0, 0)}
                        </div>
                        <div className="text-xs text-gray-500 mt-1">
                          Date: {daily.date || '—'}
                        </div>
                      </div>

                      <div className="bg-gray-900 p-6 rounded-lg border border-gray-800">
                        <div className="text-sm text-gray-500 mb-2">
                          Daily Trades
                        </div>
                        <div className="text-3xl font-bold text-blue-400">
                          {daily.trades ?? 0}
                        </div>
                        <div className="text-xs text-gray-500 mt-1">
                          Wins: {daily.wins ?? 0} | Losses:{' '}
                          {daily.losses ?? 0}
                        </div>
                      </div>

                      <div className="bg-gray-900 p-6 rounded-lg border border-gray-800">
                        <div className="text-sm text-gray-500 mb-2">
                          Total P&amp;L
                        </div>
                        <div
                          className={`text-3xl font-bold ${
                            totalPnL >= 0
                              ? 'text-green-400'
                              : 'text-red-400'
                          }`}
                        >
                          ${safeToFixed(totalPnL, 0)}
                        </div>
                        <div className="text-xs text-gray-500 mt-1">
                          All time
                        </div>
                      </div>

                      <div className="bg-gray-900 p-6 rounded-lg border border-gray-800">
                        <div className="text-sm text-gray-500 mb-2">
                          Open Positions
                        </div>
                        <div className="text-3xl font-bold text-cyan-400">
                          {openPositionsCount}
                        </div>
                        <div className="text-xs text-gray-500 mt-1">
                          Open P&amp;L: $
                          {safeToFixed(openPnL, 0)}
                        </div>
                      </div>
                    </div>

                    <div className="bg-gray-900 p-6 rounded-lg border border-gray-800">
                      <h3 className="text-lg font-bold mb-4">
                        Statistics Summary
                      </h3>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                        <div>
                          <div className="text-gray-500">
                            Total Trades
                          </div>
                          <div className="text-2xl font-bold">
                            {totalTrades}
                          </div>
                        </div>
                        <div>
                          <div className="text-gray-500">
                            Daily Win Rate
                          </div>
                          <div className="text-2xl font-bold text-green-400">
                            {safeToFixed(winRate, 1)}%
                          </div>
                        </div>
                        <div>
                          <div className="text-gray-500">Mode</div>
                          <div className="text-2xl font-bold text-yellow-400">
                            {stats.simulation ? 'SIMULATION' : 'LIVE'}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="bg-blue-900/20 border border-blue-500 rounded-lg p-4">
                      <div className="flex items-center gap-2 text-blue-400">
                        <AlertCircle className="w-5 h-5" />
                        <span className="font-semibold">
                          Stats are updated in real time based on your
                          trading activity.
                        </span>
                      </div>
                    </div>
                  </>
                );
              })()}
            </>
          ) : (
            <div className="text-center py-12 text-gray-500">
              No statistics available yet. Start trading to see stats.
            </div>
          )}
        </div>
      )}

      {/* Floating live counters */}
      <div className="fixed bottom-4 right-4 bg-gray-900 border border-gray-700 rounded-lg p-4 shadow-xl text-xs">
        <div className="text-gray-500 mb-2">Live Counts</div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-gray-400">Trades</div>
            <div className="text-xl font-bold text-blue-400">
              {streamCount}
            </div>
          </div>
          <div>
            <div className="text-gray-400">Prints</div>
            <div className="text-xl font-bold text-cyan-400">
              {printCount}
            </div>
          </div>
          <div>
            <div className="text-gray-400">Quotes</div>
            <div className="text-xl font-bold text-purple-400">
              {quoteCount}
            </div>
          </div>
          <div>
            <div className="text-gray-400">Mappings</div>
            <div className="text-xl font-bold text-green-400">
              {Object.keys(conidMapping).length}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default OptionsFlowClient;

