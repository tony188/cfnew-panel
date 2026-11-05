import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { isIP } from 'node:net';

const autoTag = '♻️ 自动选择';
const serviceGroups = ['🌍 国外媒体', '📲 电报信息', '🌐 谷歌服务', '🤖 OpenAI', 'Ⓜ️ 微软服务', '🍎 苹果服务', '📺 哔哩哔哩', '📹 油管视频', '🎬 奈飞视频', '🎯 全球直连', '🐟 漏网之鱼'];
const reservedTags = ['select', 'direct', autoTag, '🚀 节点选择', '🛑 全球拦截', '🍃 应用净化', ...serviceGroups];
let snapshot;

function inlineRuleSets() {
  if (!snapshot) {
    snapshot = JSON.parse(gunzipSync(readFileSync(new URL('./singbox-rules.json.gz', import.meta.url))));
    const freeze = value => {
      for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
      Object.freeze(value);
    };
    freeze(snapshot.rules);
  }
  return Object.entries(snapshot.rules).map(([tag, rules]) => ({ type: 'inline', tag, rules }));
}

export function normalizeNodeNames(nodes) {
  const used = new Set(reservedTags);
  return nodes.map(node => {
    const base = String(node.name || node.server + ':' + node.port);
    let name = base;
    for (let suffix = 2; used.has(name); suffix++) name = base + ' ' + suffix;
    used.add(name);
    return { ...node, name };
  });
}

function hostname(value) {
  return String(value || '').replace(/^\[|\]$/g, '');
}

function nodeOutbound(node) {
  const outbound = { type: node.proto, tag: node.name, server: hostname(node.server), server_port: node.port };
  if (node.proto === 'vless') {
    outbound.uuid = node.uuid;
    if (node.flow) outbound.flow = node.flow;
  } else outbound.password = node.password;
  if (node.tls && !(node.proto === 'trojan' && node.security === 'none')) {
    outbound.tls = {
      enabled: true,
      server_name: hostname(node.sni || node.host || node.server),
      insecure: false,
      utls: { enabled: true, fingerprint: node.fp || 'chrome' },
    };
    if (node.alpn?.length) outbound.tls.alpn = [...node.alpn];
    if (node.ech) outbound.tls.ech = { enabled: true };
  }
  // 此内核同时提供WS入口，sing-box没有原生XHTTP传输，沿用对应的WS接入。
  if (node.network === 'ws' || node.network === 'xhttp') {
    outbound.transport = {
      type: 'ws', path: node.path || '/', headers: { Host: hostname(node.host || node.server) },
      max_early_data: 2048, early_data_header_name: 'Sec-WebSocket-Protocol',
    };
  } else if (node.network === 'grpc') {
    outbound.transport = { type: 'grpc', service_name: node.path || '' };
  }
  // 不输出packet_encoding；none不是合法值。DNS走本配置的劫持与DoH链路。
  return outbound;
}

function remoteDns(address) {
  const value = String(address || 'https://1.1.1.1/dns-query').trim();
  const url = new URL(value.includes('://') ? value : 'udp://' + (isIP(value) === 6 ? '[' + value + ']' : value));
  if (url.protocol === 'quic:') throw new Error('这条Worker链路不能转发QUIC DNS，请改用HTTPS、TLS或TCP地址。');
  // Worker出口走TCP。普通DNS使用同地址的TCP入口，HTTP3地址沿用HTTPS入口。
  const types = { 'https:': 'https', 'tls:': 'tls', 'tcp:': 'tcp', 'udp:': 'tcp', 'http3:': 'https', 'h3:': 'https' };
  const type = types[url.protocol];
  if (!type || !url.hostname || url.username || url.password) throw new Error('DNS地址格式无效');
  const server = { type, tag: 'remote', server: hostname(url.hostname), detour: 'select' };
  if (url.port) server.server_port = Number(url.port);
  if (type === 'https') server.path = (url.pathname === '/' ? '/dns-query' : url.pathname) + url.search;
  return server;
}

export function buildSingboxConfig(parsedNodes, options = {}) {
  const nodes = normalizeNodeNames(parsedNodes.filter(node => node && ['vless', 'trojan'].includes(node.proto)));
  const names = nodes.map(node => node.name);
  const dns = remoteDns(options.dns);
  const bootstrapDomains = [...new Set([...nodes.flatMap(node => [node.server, node.sni, node.host]), dns.server].map(hostname).filter(value => value && !isIP(value)))];
  const preferred = names.length ? autoTag : 'direct';
  const choices = names.length ? [autoTag, ...names, 'direct'] : ['direct'];
  const groups = serviceGroups.map(tag => ({
    type: 'selector', tag,
    outbounds: tag === '🎯 全球直连' ? ['direct'] : ['select', ...names, 'direct'],
    default: ['Ⓜ️ 微软服务', '🍎 苹果服务', '📺 哔哩哔哩', '🎯 全球直连'].includes(tag) ? 'direct' : 'select',
  }));
  const routeRule = (rule_set, outbound) => ({ rule_set, outbound });
  return {
    log: { level: 'info', timestamp: true },
    dns: {
      servers: [
        { type: 'local', tag: 'local' },
        dns,
        { type: 'fakeip', tag: 'fakeip', inet4_range: '198.18.0.0/15', inet6_range: 'fc00::/18' },
      ],
      rules: [
        ...(bootstrapDomains.length ? [{ domain: bootstrapDomains, server: 'local' }] : []),
        { rule_set: 'geosite-category-ads-all', action: 'reject' },
        { rule_set: ['geosite-cn', 'geosite-private'], server: 'local' },
        { query_type: ['A', 'AAAA'], server: 'fakeip' },
      ],
      final: 'remote',
    },
    inbounds: [
      { type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 2080 },
      { type: 'tun', tag: 'tun-in', interface_name: 'sing-box', address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'], mtu: 1500, auto_route: true, strict_route: true, stack: 'mixed' },
    ],
    outbounds: [
      { type: 'selector', tag: 'select', outbounds: choices, default: preferred },
      ...(names.length ? [{ type: 'urltest', tag: autoTag, outbounds: names, url: 'https://www.gstatic.com/generate_204', interval: '5m', tolerance: 50, idle_timeout: '30m', interrupt_exist_connections: false }] : []),
      ...groups,
      ...nodes.map(nodeOutbound),
      { type: 'direct', tag: 'direct' },
    ],
    route: {
      rule_set: inlineRuleSets(),
      rules: [
        { action: 'sniff' },
        { protocol: 'dns', action: 'hijack-dns' },
        { ip_is_private: true, outbound: 'direct' },
        { rule_set: 'geosite-category-ads-all', action: 'reject' },
        // 此Worker只承载TCP及DNS，拒绝QUIC让应用回落到HTTPS。
        { network: 'udp', port: 443, action: 'reject' },
        routeRule('geosite-private', 'direct'),
        routeRule('geosite-apple-cn', 'direct'),
        routeRule('geosite-microsoft@cn', 'direct'),
        routeRule('geosite-apple', '🍎 苹果服务'),
        routeRule('geosite-microsoft', 'Ⓜ️ 微软服务'),
        routeRule(['geosite-openai', 'geosite-anthropic'], '🤖 OpenAI'),
        routeRule(['geosite-telegram', 'geoip-telegram'], '📲 电报信息'),
        routeRule('geosite-google', '🌐 谷歌服务'),
        routeRule('geosite-youtube', '📹 油管视频'),
        routeRule('geosite-netflix', '🎬 奈飞视频'),
        routeRule(['geosite-disney', 'geosite-spotify', 'geosite-tiktok', 'geosite-twitter', 'geosite-facebook'], '🌍 国外媒体'),
        routeRule(['geosite-github', 'geosite-geolocation-!cn'], 'select'),
        routeRule(['geosite-cn', 'geoip-cn'], 'direct'),
      ],
      final: '🐟 漏网之鱼',
      default_domain_resolver: { server: 'local', strategy: 'prefer_ipv4' },
      auto_detect_interface: true,
    },
    experimental: {
      cache_file: { enabled: true, store_fakeip: true },
      clash_api: { external_controller: '127.0.0.1:9090' },
    },
  };
}
