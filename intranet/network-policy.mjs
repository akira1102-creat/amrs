import { BlockList, isIP } from 'node:net';

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
