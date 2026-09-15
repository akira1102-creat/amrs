import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

const localClientAddresses = new BlockList();
for (const [network, prefix] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8], ['169.254.0.0', 16]]) {
  localClientAddresses.addSubnet(network, prefix, 'ipv4');
}
localClientAddresses.addAddress('::1', 'ipv6');
localClientAddresses.addSubnet('fc00::', 7, 'ipv6');
localClientAddresses.addSubnet('fe80::', 10, 'ipv6');

export function isAllowedIntranetClient(address) {
  const normalized = String(address || '').split('%')[0];
  const version = isIP(normalized);
  if (!version) return false;
  return localClientAddresses.check(normalized, version === 4 ? 'ipv4' : 'ipv6');
}

function isPrivateIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

export function intranetStartupMessage(port, interfaces = networkInterfaces()) {
  const addresses = [...new Set(Object.values(interfaces || {}).flatMap(entries => entries || [])
    .filter(entry => !entry.internal && (entry.family === 'IPv4' || entry.family === 4) && isPrivateIPv4(entry.address))
    .map(entry => entry.address))]
    .sort((left, right) => {
      const numeric = address => address.split('.').reduce((total, octet) => total * 256 + Number(octet), 0);
      return numeric(left) - numeric(right);
    });
  const clientUrls = addresses.map(address => `http://${address}:${port}`);
  const clientInstructions = clientUrls.length
    ? `其他電腦請使用以下其中一個主機內網網址：\n${clientUrls.map(url => `  ${url}`).join('\n')}`
    : '未偵測到主機私有 IPv4；請由公司 IT 確認內網網卡設定。';
  return `AMRS 內網版已啟動。\n本機請開啟 http://localhost:${port}\n${clientInstructions}\n`;
}
