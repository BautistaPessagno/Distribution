"use client";

import { SlotCard, useSlots } from "../account-slots";
import { ChangeCard, pendingOf, useApprovals } from "../approvals";
import { DeliveryCard, useDeliveries } from "../deliveries";
import { EmptyState, Shell } from "../shell";
import { useWorkOrders, WorkOrderCardView } from "../work-orders";

// Operations holds the work that needs a person: Work Orders (ticket 20)
// and, today, the full history of prepared Project Change Sets. The Today
// view surfaces the pending ones as an interruption; this is where every
// decision, including the ones already made, stays on the record.

export default function OperationsPage() {
  const { changes, error, reload } = useApprovals();
  const slots = useSlots();
  const orders = useWorkOrders();
  const deliveries = useDeliveries();
  const pending = pendingOf(changes);
  const decided = (changes ?? []).filter((c) => c.status !== "pending");

  return (
    <Shell>
      <section>
        <span className="tag">Manual work</span>
        <h1 className="headline" style={{ marginTop: "var(--space-2)" }}>
          Operations
        </h1>

        {error && <p className="error-text">{error}</p>}

        <h2 className="headline" style={{ fontSize: "1.1rem" }}>
          Project writes waiting on you
        </h2>
        <p className="body-text">
          A prepared Project Change Set has changed nothing. It shows you the exact diff
          an AI Host computed against a pinned Project Snapshot, and waits. Approving is
          single-use and bound to that one digest; no token ever goes to the host.
        </p>
        {pending.length === 0 ? (
          <p className="body-text">Nothing waiting.</p>
        ) : (
          <ul className="connection-list">
            {pending.map((change) => (
              <ChangeCard key={change.digest} change={change} onDecided={reload} />
            ))}
          </ul>
        )}

        {decided.length > 0 && (
          <>
            <hr className="hairline" />
            <h2 className="headline" style={{ fontSize: "1.1rem" }}>
              Decided
            </h2>
            <ul className="connection-list">
              {decided.map((change) => (
                <ChangeCard key={change.digest} change={change} onDecided={reload} />
              ))}
            </ul>
          </>
        )}

        <hr className="hairline" />
        <h2 className="headline" style={{ fontSize: "1.1rem" }}>
          Account Slots
        </h2>
        <p className="body-text">
          A slot is durable channel capacity for a Connected Project. The account filling
          it is replaceable; losing one archives it read-only with its history and the slot
          survives. MarketingOS never creates an account and never performs a platform
          action — every one of these is your own hand.
        </p>
        {slots.error && <p className="error-text">{slots.error}</p>}
        {slots.slots !== null && slots.slots.length === 0 && (
          <p className="body-text">No Account Slots yet.</p>
        )}
        {slots.slots !== null && slots.slots.length > 0 && (
          <ul className="connection-list">
            {slots.slots.map((slot) => (
              <SlotCard key={slot.id} slot={slot} onChanged={slots.reload} />
            ))}
          </ul>
        )}

        <hr className="hairline" />
        <h2 className="headline" style={{ fontSize: "1.1rem" }}>
          Deliveries
        </h2>
        <p className="body-text">
          Exported work reaches an account by hand. A release binds to exact bytes, a
          delivery pairs it with one account under a key that can never post it twice, and
          nothing counts as posted until someone comes back with the link.
        </p>
        {deliveries.error && <p className="error-text">{deliveries.error}</p>}
        {deliveries.targets !== null && deliveries.targets.length === 0 && (
          <p className="body-text">No deliveries yet.</p>
        )}
        {deliveries.targets !== null && deliveries.targets.length > 0 && (
          <ul className="connection-list">
            {deliveries.targets.map((target) => (
              <DeliveryCard key={target.id} target={target} onChanged={deliveries.reload} />
            ))}
          </ul>
        )}

        <hr className="hairline" />
        <h2 className="headline" style={{ fontSize: "1.1rem" }}>
          Work Orders
        </h2>
        <p className="body-text">
          Every platform action is your own hand, so this is where that work is handed out
          and where what came back is recorded. Nothing completes without proof, and a
          retry is a new attempt — the rejected one stays exactly as it was.
        </p>
        {orders.error && <p className="error-text">{orders.error}</p>}
        {orders.orders !== null && orders.orders.length === 0 && (
          <EmptyState tag="Manual work" title="No Work Orders yet">
            <p>
              Work Orders are manual marketing actions with one instruction, an approval
              step, and required proof. They populate when a workflow issues one for you
              to carry out.
            </p>
          </EmptyState>
        )}
        {orders.orders !== null && orders.orders.length > 0 && (
          <ul className="connection-list">
            {orders.orders.map((order) => (
              <WorkOrderCardView key={order.id} order={order} onChanged={orders.reload} />
            ))}
          </ul>
        )}
      </section>
    </Shell>
  );
}
