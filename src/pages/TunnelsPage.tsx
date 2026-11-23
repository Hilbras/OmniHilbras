import { OperatorRecordsPage } from '../components/OperatorRecordsPage';
import { listGatewayTunnels } from '../lib/gatewayClient';

const load = (signal: AbortSignal) => listGatewayTunnels(signal);

export function TunnelsContent() {
  return (
    <OperatorRecordsPage
      title='Tunnels'
      description='Saved tunnel configurations. Tokens are never returned by the gateway; `hasToken` says whether one is stored.'
      fields={['id', 'provider', 'publicUrl', 'enabled', 'hasToken']}
      load={load}
    />
  );
}
