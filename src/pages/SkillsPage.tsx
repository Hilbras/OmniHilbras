import { OperatorRecordsPage } from '../components/OperatorRecordsPage';
import { listGatewaySkills } from '../lib/gatewayClient';

const load = (signal: AbortSignal) => listGatewaySkills(signal);

export function SkillsContent() {
  return (
    <OperatorRecordsPage
      title='Skills'
      description='Saved skills. Descriptions and enabled state come from the gateway store; the skill body is not read here.'
      fields={['id', 'description', 'enabled', 'updatedAt']}
      load={load}
    />
  );
}
