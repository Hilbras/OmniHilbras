import { OperatorRecordsPage } from '../components/OperatorRecordsPage';
import { listGatewayProxyPools } from '../lib/gatewayClient';

const load = (signal: AbortSignal) => listGatewayProxyPools(signal);

export function ProxyPoolsContent() {
  return (
    <OperatorRecordsPage
      title='Proxy pools'
      description="Saved proxy pools with the gateway's own membership and health figures."
      fields={['id', 'proxy', 'enabled', 'size']}
      load={load}
    />
  );
}
