import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'; 
import { TrendingUp, TrendingDown, Zap, Activity, AlertCircle, BarChart3, Filter, Play, Pause, RefreshCw } from 'lucide-react';

const DEAD_ZONE = 5000; // small dead zone to avoid tiny noise in net delta

// === Helpers for delta → stance/formatting ===
function stanceFromNetDelta(netDelta, deadZone) {
  if (netDelta > deadZone) return 'BULL';
  if (netDelta < -deadZone) return 'BEAR';
  return 'NEUTRAL';
}

function fmtDeltaCompact(netDelta) {
  if (!netDelta) return '0 Δ';
  const sign = netDelta >= 0 ? '+' : '-';
  const abs = Math.abs(netDelta);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M Δ`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}k Δ`;
  return `${sign}${abs.toFixed(0)} Δ`;
}

function stanceTextColor(stance) {
  if (stance === 'BULL') return 'text-green-400';
  if (stance === 'BEAR') return 'text-red-400';
  return 'text-yellow-300';
}

// trades → { overallFlow, symbolFlows[] }
function computeDeltaFlows(trades) {
  const perSymbol = {};
  let total = 0;

  for (const t of trades) {
    const sym = t.symbol;
    if (!sym) continue;

    const size = Number(t.size ?? 0);
    const delta = Number(t.greeks?.delta ?? 0);
    if (!size || !delta) continue;

    // Equity options ~100, futures options ~50 (or custom)
    const multiplier =
      typeof t.multiplier === 'number'
        ? t.multiplier
        : t.assetClass === 'FUTURES_OPTION'
        ? 50
        : 100;

    const base = delta * size * multiplier;

    let signed = base;
    switch (t.direction) {
      case 'BTO':
      case 'STC':
        signed = base;
        break;
      case 'STO':
      case 'BTC':
        signed = -base;
        break;
      default:
        // fallback: treat BUY-agg as positive, SELL-agg as negative
        signed = t.aggressor ? base : -base;
    }

    perSymbol[sym] = (perSymbol[sym] || 0) + signed;
    total += signed;
  }

  const symbolFlows = Object.entries(perSymbol)
    .map(([symbol, netDelta]) => ({
      symbol,
      netDelta,
      stance: stanceFromNetDelta(netDelta, DEAD_ZONE),
    }))
    // biggest deltas on top
    .sort((a, b) => Math.abs(b.netDelta) - Math.abs(a.netDelta));

  const overallFlow = {
    netDelta: total,
    stance: stanceFromNetDelta(total, DEAD_ZONE),
  };

  return { overallFlow, symbolFlows };
}

const FlowSummaryStrip = ({ overall, symbols }) => {
  if (!symbols.length && !overall.netDelta) return null;

  const top = symbols.slice(0, 4); // show top 4 by |Δ|

  return (
    <div className="mt-2 mb-4 px-3 py-2 rounded-lg border border-gray-800 bg-gray-900/80 flex flex-wrap items-center gap-3 text-xs">
      <div className="flex items-center gap-2 mr-3">
        <span className="text-gray-400">Overall Flow:</span>
        <span className={`font-semibold ${stanceTextColor(overall.stance)}`}>{overall.stance}</span>
        <span className="text-gray-100">{fmtDeltaCompact(overall.netDelta)}</span>
      </div>

      {top.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          {top.map((s) => (
            <div key={s.symbol} className="flex items-center gap-1">
              <span className="text-gray-400">{s.symbol}</span>
              <span className={`font-semibold ${stanceTextColor(s.stance)}`}>{s.stance}</span>
              <span className="text-gray-100">{fmtDeltaCompact(s.netDelta)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const OptionsFlowClient = () => {
  const [connected, setConnected] = useState(false);
  const [activeTab, setActiveTab] = useState('stream');
  const [trades, setTrades] = useState([]);
  const [prints, setPrints] = useState([]);
  const [quotes, setQuotes] = useState({});
  const [ulQuotes, setUlQuotes] = useState({});
  const [conidMapping, setConidMapping] = useState({});
  const [stats, setStats] = useState(null);
  const [autoTrades, setAutoTrades] = useState([]);
  const [filters, setFilters] = useState({ 
    symbol: '', 
    minPremium: 0, 
    direction: 'all', 
    classification: 'all', 
    stance: 'all' 
  });
  const [isPaused, setIsPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(false); // <-- default OFF now
  
  const wsRef = useRef(null);
  const streamEndRef = useRef(null);

  const streamCount = trades.length;
  const printCount = prints.length;
  const quoteCount = Object.keys(quotes).length;
  const autoCount = autoTrades.length;

  // === NEW: cumulative delta flows for scoreboard ===
  const { overallFlow, symbolFlows } = useMemo(
    () => computeDeltaFlows(trades),
    [trades]
  );

  // Auto-scroll effect (only if manually enabled)
  useEffect(() => {
    if (autoScroll && streamEndRef.current) {
      streamEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [trades, autoScroll]);

  const connectWebSocket = useCallback(() => {
    const ws = new WebSocket('ws://localhost:3000/ws');
    
    ws.onopen = () => {
      setConnected(true);
      console.log('✅ Connected to Options Flow');
      ws.send(JSON.stringify({ 
        action: 'subscribe', 
        futuresSymbols: ['/ES', '/NQ'], 
        equitySymbols: ['SPY', 'QQQ', 'AAPL', 'TSLA'] 
      }));
    };
    
    ws.onmessage = (event) => {
      if (isPaused) return;
      
      const data = JSON.parse(event.data);
      
      if (data.type === 'CONID_MAPPING') {
        setConidMapping(prev => ({ 
          ...prev, 
          [data.conid]: data.mapping 
        }));
      } 
      else if (data.type === 'CALL' || data.type === 'PUT') {
        const enrichedTrade = {
          ...data,
          receivedAt: Date.now(),
          initialPrice: data.optionPrice,
          priceChange: 0,
          priceChangePct: 0,
          currentPrice: data.optionPrice
        };
        
        setTrades(prev => [enrichedTrade, ...prev].slice(0, 200));
        
        // Add to prints for the prints tab
        setPrints(prev => [{
          ...data,
          type: 'PRINT',
          stance: data.stanceLabel,
          tradeSize: data.size,
          tradePrice: data.optionPrice,
          volOiRatio: data.volOiRatio,
          aggressor: data.aggressor ? 'BUY-agg' : 'SELL-agg'
        }, ...prev].slice(0, 100));
        
        if (data.isAutoTrade) {
          setAutoTrades(prev => [enrichedTrade, ...prev].slice(0, 50));
        }
      } 
      else if (data.type === 'LIVE_QUOTE') {
        setQuotes(prev => ({ ...prev, [data.conid]: data }));
        
        // Update current prices in trades for P&L calculation
        setTrades(prev => prev.map(trade => {
          if (trade.conid === data.conid) {
            const priceChange = data.last - trade.initialPrice;
            const priceChangePct = (priceChange / trade.initialPrice) * 100;
            return { 
              ...trade, 
              currentPrice: data.last, 
              priceChange, 
              priceChangePct 
            };
          }
          return trade;
        }));
        
        // Update auto trades P&L
        setAutoTrades(prev => prev.map(trade => {
          if (trade.conid === data.conid) {
            const priceChange = data.last - trade.initialPrice;
            const priceChangePct = (priceChange / trade.initialPrice) * 100;
            return { 
              ...trade, 
              currentPrice: data.last, 
              priceChange, 
              priceChangePct 
            };
          }
          return trade;
        }));
      } 
      else if (data.type === 'UL_LIVE_QUOTE') {
        setUlQuotes(prev => ({ ...prev, [data.conid]: data }));
      } 
      else if (data.type === 'TRADING_STATS') {
        setStats(data.stats);
      }
    };
    
    ws.onclose = () => {
      setConnected(false);
      console.log('❌ Disconnected from Options Flow');
      setTimeout(connectWebSocket, 3000);
    };
    
    ws.onerror = () => {
      setConnected(false);
    };
    
    wsRef.current = ws;
  }, [isPaused]);

  useEffect(() => {
    connectWebSocket();
    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, [connectWebSocket]);

  const getMapping = (conid) => {
    return conidMapping[conid] || { symbol: 'Unknown', type: 'OPT' };
  };

  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit' 
    });
  };

  const formatPremium = (premium) => {
    if (!premium) return '$0';
    if (premium >= 1000000) return `$${(premium / 1000000).toFixed(2)}M`;
    if (premium >= 1000) return `$${(premium / 1000).toFixed(0)}k`;
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
    
    return classifications.map(cls => {
      let bgColor = 'bg-gray-700';
      if (cls === 'SWEEP') bgColor = 'bg-red-600';
      else if (cls === 'BLOCK') bgColor = 'bg-orange-600';
      else if (cls === 'NOTABLE') bgColor = 'bg-green-600';
      
      return (
        <span key={cls} className={`px-2 py-1 text-xs font-bold rounded ${bgColor}`}>
          {cls}
        </span>
      );
    });
  };

  const getDirectionStyle = (direction) => {
    const styles = {
      'BTO': 'bg-green-700 text-white',
      'STO': 'bg-orange-700 text-white', 
      'BTC': 'bg-cyan-700 text-white',
      'STC': 'bg-purple-700 text-white'
    };
    return styles[direction] || 'bg-gray-700 text-white';
  };

  const filteredTrades = trades.filter(trade => {
    if (filters.symbol && !trade.symbol?.toUpperCase().includes(filters.symbol.toUpperCase())) return false;
    if (filters.minPremium && trade.premium < filters.minPremium) return false;
    if (filters.direction !== 'all' && trade.direction !== filters.direction) return false;
    if (filters.classification !== 'all' && !trade.classifications?.includes(filters.classification)) return false;
    if (filters.stance !== 'all' && trade.stanceLabel !== filters.stance) return false;
    return true;
  });

  const getCurrentULPrice = (ulConid) => {
    const ulQuote = ulQuotes[ulConid];
    return ulQuote ? ulQuote.last : 0;
  };

  const calculatePnL = (trade) => {
    const currentPrice = trade.currentPrice || trade.optionPrice;
    const entryPrice = trade.optionPrice;
    const contracts = trade.size || 1;
    const multiplier = trade.multiplier || (trade.assetClass === 'FUTURES_OPTION' ? 20 : 100);
    const priceDiff = currentPrice - entryPrice;
    const dollarPnL = priceDiff * contracts * multiplier;
    const percentPnL = (priceDiff / entryPrice) * 100;
    
    return { dollarPnL, percentPnL };
  };

  const clearAllData = () => {
    setTrades([]);
    setPrints([]);
    setQuotes({});
    setUlQuotes({});
    setAutoTrades([]);
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-4">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full ${connected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
            <h1 className="text-3xl font-bold">Options Flow Monitor</h1>
            <span className="text-sm text-gray-400">ws://localhost:3000/ws</span>
          </div>
          
          <div className="flex items-center gap-2">
            <button 
              onClick={() => setIsPaused(!isPaused)}
              className={`flex items-center gap-2 px-3 py-2 rounded ${
                isPaused ? 'bg-yellow-600 hover:bg-yellow-700' : 'bg-gray-700 hover:bg-gray-600'
              }`}
            >
              {isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
              {isPaused ? 'Resume' : 'Pause'}
            </button>
            
            <button 
              onClick={clearAllData}
              className="flex items-center gap-2 px-3 py-2 bg-red-600 hover:bg-red-700 rounded"
            >
              <RefreshCw className="w-4 h-4" />
              Clear
            </button>
          </div>
        </div>
        
        <div className="text-sm text-gray-400 mb-4">
          Connected to IBKR Flow (Equities + Futures) - 25 ATM, ~15 DTE with live quotes, prints & BTO/STO/BTC/STC
        </div>

        {/* Symbol Buttons */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <div className="text-xs text-gray-500 mb-2">Futures:</div>
            <div className="flex flex-wrap gap-2">
              {['/ES', '/NQ', '/YM', '/RTY', '/CL', '/GC'].map(sym => (
                <button 
                  key={sym}
                  className="px-4 py-2 bg-gray-800 hover:bg-cyan-700 rounded font-semibold transition-colors"
                  onClick={() => setFilters(prev => ({ ...prev, symbol: sym }))}
                >
                  {sym}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500 mb-2">Equities:</div>
            <div className="flex flex-wrap gap-2">
              {['SPY', 'QQQ', 'AAPL', 'TSLA', 'NVDA', 'AMZN', 'MSFT', 'META', 'GOOGL'].map(sym => (
                <button 
                  key={sym}
                  className="px-4 py-2 bg-gray-800 hover:bg-purple-700 rounded font-semibold transition-colors"
                  onClick={() => setFilters(prev => ({ ...prev, symbol: sym }))}
                >
                  {sym}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Controls */}
        <div className="flex gap-4 mb-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input 
              type="checkbox" 
              className="w-4 h-4" 
              checked={isPaused}
              onChange={() => setIsPaused(!isPaused)}
            />
            <span className="text-sm">Pause</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input 
              type="checkbox" 
              className="w-4 h-4" 
              checked={autoScroll}
              onChange={() => setAutoScroll(!autoScroll)}
            />
            <span className="text-sm">Auto-scroll</span>
          </label>
        </div>

        {/* NEW: Overall Flow / per-symbol delta strip */}
        <FlowSummaryStrip overall={overallFlow} symbols={symbolFlows} />

        {/* Tabs */}
        <div className="flex gap-2 mb-4">
          {[
            { id: 'stream', label: 'Stream', count: streamCount, icon: Activity },
            { id: 'trades', label: 'Trades', count: streamCount, icon: BarChart3 },
            { id: 'prints', label: 'Prints', count: printCount, icon: Filter },
            { id: 'quotes', label: 'Quotes', count: quoteCount, icon: TrendingUp },
            { id: 'auto', label: 'Auto', count: autoCount, icon: Zap },
            { id: 'stats', label: 'Stats', count: null, icon: AlertCircle }
          ].map(({ id, label, count, icon: Icon }) => (
            <button 
              key={id}
              onClick={() => setActiveTab(id)}
              className={`flex items-center px-6 py-3 rounded-lg font-semibold transition-all ${
                activeTab === id 
                  ? 'bg-blue-600 text-white' 
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
            >
              <Icon className="w-4 h-4 mr-2" />
              {label}
              {count !== null && <span className="ml-2">{count}</span>}
            </button>
          ))}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3 bg-gray-900 p-4 rounded-lg border border-gray-800">
          <input 
            type="text"
            placeholder="Symbol filter (e.g., NVDA)"
            value={filters.symbol}
            onChange={(e) => setFilters(prev => ({ ...prev, symbol: e.target.value }))}
            className="px-4 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-blue-500"
          />
          
          <select 
            value={filters.direction}
            onChange={(e) => setFilters(prev => ({ ...prev, direction: e.target.value }))}
            className="px-4 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-blue-500"
          >
            <option value="all">Any direction</option>
            <option value="BTO">BTO</option>
            <option value="STO">STO</option>
            <option value="BTC">BTC</option>
            <option value="STC">STC</option>
          </select>
          
          <select 
            value={filters.classification}
            onChange={(e) => setFilters(prev => ({ ...prev, classification: e.target.value }))}
            className="px-4 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-blue-500"
          >
            <option value="all">All classifications</option>
            <option value="SWEEP">Sweeps</option>
            <option value="BLOCK">Blocks</option>
            <option value="NOTABLE">Notables</option>
          </select>
          
          <select 
            value={filters.stance}
            onChange={(e) => setFilters(prev => ({ ...prev, stance: e.target.value }))}
            className="px-4 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-blue-500"
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
            onChange={(e) => setFilters(prev => ({ ...prev, minPremium: Number(e.target.value) }))}
            className="px-4 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>

      {/* Content */}
      {(activeTab === 'stream' || activeTab === 'trades') && (
        <div className="space-y-3">
          {filteredTrades.map((trade, idx) => {
            const ulMapping = getMapping(trade.underlyingConid);
            const currentULPrice = getCurrentULPrice(trade.underlyingConid);
            const ulPriceChange = currentULPrice && trade.underlyingPrice 
              ? ((currentULPrice - trade.underlyingPrice) / trade.underlyingPrice * 100).toFixed(2) 
              : '0.00';
            
            const { dollarPnL, percentPnL } = calculatePnL(trade);
            const pnlColor = dollarPnL >= 0 ? 'text-green-400' : 'text-red-400';
            
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
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    {getClassificationBadges(trade.classifications)}
                    
                    <span className={`px-2 py-1 text-xs font-bold rounded ${getDirectionStyle(trade.direction)}`}>
                      {trade.direction}
                    </span>
                    
                    <div className={`flex items-center gap-1 px-2 py-1 rounded border ${getStanceBg(trade.stanceLabel)}`}>
                      {trade.stanceLabel === 'BULL' ? <TrendingUp className="w-4 h-4" /> : 
                       trade.stanceLabel === 'BEAR' ? <TrendingDown className="w-4 h-4" /> : 
                       <Activity className="w-4 h-4" />}
                      <span className={`font-bold text-sm ${getStanceColor(trade.stanceLabel)}`}>
                        {trade.stanceLabel}
                      </span>
                      <span className="text-xs text-gray-400">({trade.stanceScore})</span>
                    </div>
                    
                    <div className="flex items-center gap-1 px-2 py-1 bg-yellow-900/30 rounded border border-yellow-600">
                      <Zap className="w-4 h-4 text-yellow-400" />
                      <span className="font-semibold text-sm text-yellow-400">{trade.confidence}%</span>
                    </div>
                    
                    <span className="text-xs text-gray-400">
                      {formatTime(trade.timestamp || trade.receivedAt)}
                    </span>
                    
                    <span className="px-2 py-1 text-xs bg-gray-800 rounded">
                      {trade.assetClass === 'FUTURES_OPTION' ? '📊 FUT' : '📈 EQ'}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 mb-3">
                  <div>
                    <div className="text-2xl font-bold mb-1">
                      {trade.symbol} {trade.type} ${trade.strike}
                    </div>
                    <div className="text-sm text-gray-400 space-y-1">
                      <div>exp {trade.expiry} • DTE {trade.dte}</div>
                      <div>Moneyness: {((trade.moneyness || 0) * 100).toFixed(2)}%</div>
                      <div className="flex items-center gap-2">
                        <span>UL: {ulMapping.symbol || trade.symbol}</span>
                        <span className="font-semibold">${(currentULPrice || trade.underlyingPrice).toFixed(2)}</span>
                        {currentULPrice && (
                          <span className={`text-xs ${
                            parseFloat(ulPriceChange) >= 0 ? 'text-green-400' : 'text-red-400'
                          }`}>
                            ({parseFloat(ulPriceChange) >= 0 ? '+' : ''}{ulPriceChange}%)
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  
                  <div className="text-right">
                    <div className="text-3xl font-bold text-green-400 mb-1">
                      {formatPremium(trade.premium)}
                    </div>
                    <div className="text-sm text-gray-400 space-y-1">
                      <div>{trade.size} contracts @ ${trade.optionPrice?.toFixed(2)}</div>
                      {trade.currentPrice && (
                        <>
                          <div>Now: ${trade.currentPrice.toFixed(2)}</div>
                          <div className={`font-semibold ${pnlColor}`}>
                            P&L: {percentPnL >= 0 ? '+' : ''}{percentPnL.toFixed(1)}% 
                            ({dollarPnL >= 0 ? '+' : ''}${dollarPnL.toFixed(0)})
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-7 gap-3 text-sm mb-3">
                  <div>
                    <div className="text-gray-500 text-xs">Delta</div>
                    <div className="font-semibold text-blue-400">{trade.greeks?.delta?.toFixed(3)}</div>
                  </div>
                  <div>
                    <div className="text-gray-500 text-xs">IV</div>
                    <div className="font-semibold text-purple-400">{trade.greeks?.iv?.toFixed(1)}%</div>
                  </div>
                  <div>
                    <div className="text-gray-500 text-xs">Vol/OI</div>
                    <div className="font-semibold text-yellow-400">{trade.volOiRatio?.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-gray-500 text-xs">OI</div>
                    <div className="font-semibold">{trade.openInterest?.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-gray-500 text-xs">Vol</div>
                    <div className="font-semibold">{trade.size}</div>
                  </div>
                  <div>
                    <div className="text-gray-500 text-xs">Bid/Ask</div>
                    <div className="font-semibold text-xs">
                      {trade.bid?.toFixed(2)}/{trade.ask?.toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div className="text-gray-500 text-xs">Aggressor</div>
                    <div className={`font-semibold ${trade.aggressor ? 'text-green-400' : 'text-red-400'}`}>
                      {trade.aggressor ? 'BUY' : 'SELL'}
                    </div>
                  </div>
                </div>

                {trade.historicalComparison && (
                  <div className="bg-gray-950 p-3 rounded border border-gray-800">
                    <div className="text-xs text-gray-500 mb-2">Historical Comparison (12d avg)</div>
                    <div className="grid grid-cols-5 gap-3 text-xs">
                      <div>
                        <div className="text-gray-500">Avg OI</div>
                        <div className="font-semibold">{trade.historicalComparison.avgOI?.toLocaleString()}</div>
                      </div>
                      <div>
                        <div className="text-gray-500">Avg Vol</div>
                        <div className="font-semibold">{trade.historicalComparison.avgVolume?.toLocaleString()}</div>
                      </div>
                      <div>
                        <div className="text-gray-500">OI Δ</div>
                        <div className={`font-semibold ${
                          trade.historicalComparison.oiChange > 0 ? 'text-green-400' : 'text-red-400'
                        }`}>
                          {trade.historicalComparison.oiChange > 0 ? '+' : ''}
                          {trade.historicalComparison.oiChange?.toLocaleString()}
                        </div>
                      </div>
                      <div>
                        <div className="text-gray-500">Vol Multiple</div>
                        <div className={`font-semibold ${
                          trade.historicalComparison.volumeMultiple > 2 ? 'text-yellow-400' : ''
                        }`}>
                          {trade.historicalComparison.volumeMultiple?.toFixed(2)}x
                        </div>
                      </div>
                      <div>
                        <div className="text-gray-500">Data Points</div>
                        <div className="font-semibold">{trade.historicalComparison.dataPoints}</div>
                      </div>
                    </div>
                  </div>
                )}

                {trade.stanceReasons && (
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
          
          <div ref={streamEndRef} />
        </div>
      )}

      {/* (prints / quotes / auto / stats sections unchanged) */}
      {/* ... your existing code for prints, quotes, auto, stats, floating stats bar remains here ... */}
      {/* I kept everything below as-is in your original file. */}
      
      {activeTab === 'prints' && (
        <div className="space-y-2">
          {prints.map((print, idx) => {
            const stanceColor = print.stance === 'BULL' ? 'text-green-400' : 
                              print.stance === 'BEAR' ? 'text-red-400' : 'text-yellow-400';
            
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
                      <span className={`px-2 py-1 text-xs font-bold rounded border ${
                        print.stance === 'BULL' ? 'bg-green-900/30 border-green-500' :
                        print.stance === 'BEAR' ? 'bg-red-900/30 border-red-500' :
                        'bg-yellow-900/30 border-yellow-500'
                      }`}>
                        <span className={stanceColor}>{print.stance}</span>
                        {print.stanceScore && ` ${print.stanceScore}`}
                      </span>
                    )}
                    
                    <span className="font-bold text-lg">
                      {print.symbol} {print.right} ${print.strike}
                    </span>
                    
                    <span className="text-gray-400 text-sm">{print.expiry}</span>
                    
                    <span className="text-cyan-400 font-semibold">
                      {print.tradeSize} @ ${print.tradePrice?.toFixed(2)}
                    </span>
                    
                    <span className="text-gray-400">
                      {formatPremium(print.premium)}
                    </span>
                    
                    <span className="text-yellow-400 text-sm">
                      Vol/OI: {print.volOiRatio?.toFixed(2)}
                    </span>
                    
                    <span className={`text-sm font-semibold ${
                      print.aggressor ? 'text-green-400' : 'text-red-400'
                    }`}>
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

      {activeTab === 'quotes' && (
        <div className="space-y-2">
          {Object.entries(quotes).map(([conid, quote]) => {
            const mapping = getMapping(conid);
            const isOption = mapping.type !== 'UNDERLYING';
            
            return (
              <div key={conid} className="p-3 bg-gray-900 rounded-lg border border-gray-800">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <span className={`px-2 py-1 text-xs font-bold rounded ${
                      isOption ? 'bg-blue-900 text-blue-300' : 'bg-purple-900 text-purple-300'
                    }`}>
                      {isOption ? 'OPT' : 'UL'}
                    </span>
                    
                    <div>
                      <div className="font-bold text-lg">
                        {mapping.symbol || `conid ${conid}`}
                        {isOption && mapping.right && (
                          <span className="ml-2 text-gray-400">
                            {mapping.right === 'C' ? 'CALL' : 'PUT'} ${mapping.strike}
                          </span>
                        )}
                      </div>
                      {mapping.expiry && (
                        <div className="text-xs text-gray-500">exp {mapping.expiry}</div>
                      )}
                    </div>
                    
                    <div className="text-lg font-semibold">
                      last <span className="text-cyan-400">${quote.last?.toFixed(2)}</span>
                    </div>
                    
                    <div className="text-sm text-gray-400">
                      bid <span className="text-green-400">${quote.bid?.toFixed(2)}</span>
                    </div>
                    
                    <div className="text-sm text-gray-400">
                      ask <span className="text-red-400">${quote.ask?.toFixed(2)}</span>
                    </div>
                    
                    {quote.delta !== undefined && (
                      <div className="text-sm">
                        Δ <span className="text-blue-400 font-semibold">{quote.delta?.toFixed(3)}</span>
                      </div>
                    )}
                    
                    <div className="text-sm text-gray-500">
                      vol {quote.volume || 0}
                    </div>
                  </div>
                  
                  <span className="text-xs text-gray-500">
                    {formatTime(quote.timestamp)}
                  </span>
                </div>
              </div>
            );
          })}
          
          {Object.entries(ulQuotes).map(([conid, quote]) => {
            const mapping = getMapping(conid);
            
            return (
              <div key={`ul-${conid}`} className="p-3 bg-gray-900 rounded-lg border border-purple-800">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <span className="px-2 py-1 text-xs font-bold rounded bg-purple-900 text-purple-300">
                      UL
                    </span>
                    
                    <div className="font-bold text-xl">
                      {mapping.symbol || `conid ${conid}`}
                    </div>
                    
                    <div className="text-lg font-semibold">
                      last <span className="text-purple-400">${quote.last?.toFixed(2)}</span>
                    </div>
                    
                    <div className="text-sm text-gray-400">
                      bid ${quote.bid?.toFixed(2)}
                    </div>
                    
                    <div className="text-sm text-gray-400">
                      ask ${quote.ask?.toFixed(2)}
                    </div>
                    
                    <div className="text-sm text-gray-500">
                      vol {quote.volume || 0}
                    </div>
                  </div>
                  
                  <span className="text-xs text-gray-500">
                    {formatTime(quote.timestamp)}
                  </span>
                </div>
              </div>
            );
          })}
          
          {Object.keys(quotes).length === 0 && Object.keys(ulQuotes).length === 0 && (
            <div className="text-center py-12 text-gray-500">
              No quotes yet. Waiting for quote data...
            </div>
          )}
        </div>
      )}

      {activeTab === 'auto' && (
        <div className="space-y-3">
          {autoTrades.length > 0 ? (
            autoTrades.map((trade, idx) => {
              const { dollarPnL, percentPnL } = calculatePnL(trade);
              const pnlColor = dollarPnL >= 0 ? 'text-green-400' : 'text-red-400';
              
              return (
                <div key={`auto-${idx}`} className="p-4 bg-yellow-900/20 rounded-lg border-2 border-yellow-500">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <span className="px-3 py-1 bg-yellow-600 text-white font-bold rounded">
                        AUTO-TRADE
                      </span>
                      <div className="text-2xl font-bold">
                        {trade.symbol} {trade.type} ${trade.strike}
                      </div>
                    </div>
                    
                    <div className="text-right">
                      <div className={`text-2xl font-bold ${pnlColor}`}>
                        {percentPnL >= 0 ? '+' : ''}{percentPnL.toFixed(2)}%
                      </div>
                      <div className={`text-sm ${pnlColor}`}>
                        {dollarPnL >= 0 ? '+' : ''}${dollarPnL.toFixed(0)}
                      </div>
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-4 gap-4 text-sm">
                    <div>
                      <div className="text-gray-500">Entry</div>
                      <div className="font-semibold">${trade.optionPrice?.toFixed(2)}</div>
                    </div>
                    <div>
                      <div className="text-gray-500">Current</div>
                      <div className="font-semibold text-cyan-400">
                        ${(trade.currentPrice || trade.optionPrice)?.toFixed(2)}
                      </div>
                    </div>
                    <div>
                      <div className="text-gray-500">Contracts</div>
                      <div className="font-semibold">{trade.size}</div>
                    </div>
                    <div>
                      <div className="text-gray-500">Premium</div>
                      <div className="font-semibold">{formatPremium(trade.premium)}</div>
                    </div>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="text-center py-12 text-gray-500">
              No auto-trades yet
            </div>
          )}
        </div>
      )}

      {activeTab === 'stats' && (
        <div className="space-y-4">
          {stats ? (
            <>
              <div className="grid grid-cols-4 gap-4">
                <div className="bg-gray-900 p-6 rounded-lg border border-gray-800">
                  <div className="text-sm text-gray-500 mb-2">Daily P&L</div>
                  <div className={`text-3xl font-bold ${
                    stats.daily.pnl >= 0 ? 'text-green-400' : 'text-red-400'
                  }`}>
                    ${stats.daily.pnl?.toFixed(0)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Date: {stats.daily.date}
                  </div>
                </div>
                
                <div className="bg-gray-900 p-6 rounded-lg border border-gray-800">
                  <div className="text-sm text-gray-500 mb-2">Daily Trades</div>
                  <div className="text-3xl font-bold text-blue-400">
                    {stats.daily.trades}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Wins: {stats.daily.wins} | Losses: {stats.daily.losses}
                  </div>
                </div>
                
                <div className="bg-gray-900 p-6 rounded-lg border border-gray-800">
                  <div className="text-sm text-gray-500 mb-2">Total P&L</div>
                  <div className={`text-3xl font-bold ${
                    stats.totalPnL >= 0 ? 'text-green-400' : 'text-red-400'
                  }`}>
                    ${stats.totalPnL?.toFixed(0)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    All time
                  </div>
                </div>
                
                <div className="bg-gray-900 p-6 rounded-lg border border-gray-800">
                  <div className="text-sm text-gray-500 mb-2">Open Positions</div>
                  <div className="text-3xl font-bold text-cyan-400">
                    {stats.openPositionsCount || 0}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Open P&L: ${stats.openPnL?.toFixed(0) || 0}
                  </div>
                </div>
              </div>
              
              <div className="bg-gray-900 p-6 rounded-lg border border-gray-800">
                <h3 className="text-lg font-bold mb-4">Statistics Summary</h3>
                <div className="grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <div className="text-gray-500">Total Trades</div>
                    <div className="text-2xl font-bold">{stats.totalTrades || 0}</div>
                  </div>
                  <div>
                    <div className="text-gray-500">Win Rate</div>
                    <div className="text-2xl font-bold text-green-400">
                      {stats.daily.trades > 0 ? ((stats.daily.wins / stats.daily.trades) * 100).toFixed(1) : 0}%
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
                    Stats are updated in real-time based on your trading activity
                  </span>
                </div>
              </div>
            </>
          ) : (
            <div className="text-center py-12 text-gray-500">
              No statistics available yet. Start trading to see stats.
            </div>
          )}
        </div>
      )}

      {/* Floating Stats Bar */}
      <div className="fixed bottom-4 right-4 bg-gray-900 border border-gray-700 rounded-lg p-4 shadow-xl">
        <div className="text-xs text-gray-500 mb-2">Live Counts</div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-gray-400">Trades</div>
            <div className="text-xl font-bold text-blue-400">{streamCount}</div>
          </div>
          <div>
            <div className="text-gray-400">Prints</div>
            <div className="text-xl font-bold text-cyan-400">{printCount}</div>
          </div>
          <div>
            <div className="text-gray-400">Quotes</div>
            <div className="text-xl font-bold text-purple-400">{quoteCount}</div>
          </div>
          <div>
            <div className="text-gray-400">Mappings</div>
            <div className="text-xl font-bold text-green-400">{Object.keys(conidMapping).length}</div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default OptionsFlowClient;
