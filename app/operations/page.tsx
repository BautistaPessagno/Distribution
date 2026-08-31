import { EmptyState, Shell } from "../shell";

export default function OperationsPage() {
  return (
    <Shell>
      <EmptyState tag="Manual work" title="No Work Orders yet">
        <p>Operations lists Work Orders: manual marketing actions with instructions, approval policy, and required proof. It populates when the AI Host or a workflow issues a Work Order for you to carry out.</p>
      </EmptyState>
    </Shell>
  );
}
