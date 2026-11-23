import { OperatorRecordsPage } from '../components/OperatorRecordsPage';
import { listGatewayMitm } from '../lib/gatewayClient';

const load = (signal: AbortSignal) => listGatewayMitm(signal);

export function MitmContent() {
  return (
    <OperatorRecordsPage
      title='MITM'
      description="Interception profiles the gateway has saved. Ports, certificate paths and enabled state are the gateway's own values."
      fields={['id', 'port', 'enabled', 'certPath']}
      load={load}
    />
  );
}
