import type { LeadDetail, LeadMembershipDetail } from '@cadentor/shared';
import { Badge, Stat, StatusBadge } from '../../components/ui';
import { formatInZone, formatTime, humanize } from '../../lib/format';

export function LeadDetailView({ lead }: { lead: LeadDetail }) {
  return (
    <div className="divide-y divide-zinc-800 text-xs">
      <dl className="grid grid-cols-2 gap-3 p-4">
        <Stat label="Name" value={lead.name} />
        <Stat label="Automation" value={<StatusBadge status={lead.automation.mode} />} />
        <Stat label="Phone" value={lead.phone} />
        <Stat label="Email" value={lead.email ?? '—'} />
        <Stat label="Timezone" value={lead.timezone ?? '—'} />
        <Stat label="Lead status" value={humanize(lead.status)} />
        <Stat
          label="Import source"
          value={
            lead.importBatch === null
              ? lead.source
              : `${lead.importBatch.sourceLabel} · ${formatTime(lead.importBatch.startedAt)}`
          }
        />
        <Stat label="Created" value={formatTime(lead.createdAt)} />
      </dl>

      <section aria-label="Suppression" className="space-y-1.5 p-4">
        <h3 className="text-[11px] font-medium text-zinc-500">Suppression</h3>
        {lead.suppression.length === 0 ? (
          <Badge tone="emerald">Not suppressed</Badge>
        ) : (
          <ul className="space-y-1">
            {lead.suppression.map((entry, index) => (
              <li key={`${entry.createdAt}-${index}`} className="flex items-center gap-2">
                <Badge tone="rose">{humanize(entry.reason)}</Badge>
                <span className="text-zinc-400">
                  {humanize(entry.source)} · {formatTime(entry.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {lead.memberships.length === 0 ? (
        <p className="p-4 text-zinc-500">No campaign memberships.</p>
      ) : (
        lead.memberships.map((membership) => (
          <Membership key={membership.id} membership={membership} />
        ))
      )}
    </div>
  );
}

function Membership({ membership: m }: { membership: LeadMembershipDetail }) {
  const evaluation = m.latestEvaluation;
  return (
    <section aria-label={`Membership in ${m.campaign.name}`} className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={`#/campaigns/${m.campaign.id}`}
          className="font-medium text-zinc-100 hover:underline"
        >
          {m.campaign.name}
        </a>
        <StatusBadge status={m.status} />
        <span className="text-[11px] text-zinc-500">since {formatTime(m.statusChangedAt)}</span>
      </div>

      <div>
        <h4 className="mb-1 text-[11px] font-medium text-zinc-500">Qualification facts</h4>
        {m.facts.length === 0 ? (
          <p className="text-zinc-500">None recorded.</p>
        ) : (
          <table className="w-full text-left">
            <tbody className="divide-y divide-zinc-800/70">
              {m.facts.map((fact) => (
                <tr key={fact.field}>
                  <td className="py-1 pr-2 font-mono text-zinc-400">{fact.field}</td>
                  <td className="py-1 pr-2 text-zinc-100">{String(fact.value ?? '—')}</td>
                  <td className="py-1 text-right text-[11px] text-zinc-500">
                    {humanize(fact.source)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div>
        <h4 className="mb-1 text-[11px] font-medium text-zinc-500">Latest evaluation</h4>
        {evaluation === null ? (
          <p className="text-zinc-500">Not evaluated.</p>
        ) : (
          <p className="flex flex-wrap items-center gap-1.5 text-zinc-400">
            <StatusBadge status={evaluation.result} />
            {formatTime(evaluation.evaluatedAt)}
            {evaluation.missingFields.length > 0 &&
              ` · missing ${evaluation.missingFields.join(', ')}`}
          </p>
        )}
      </div>

      <div>
        <h4 className="mb-1 text-[11px] font-medium text-zinc-500">Booking</h4>
        {m.bookings.length === 0 ? (
          <p className="text-zinc-500">No booking opportunity.</p>
        ) : (
          <ul className="space-y-1.5">
            {m.bookings.map((booking) => (
              <li key={booking.id} className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <StatusBadge status={booking.status} />
                  <span className="text-zinc-200">
                    {formatInZone(booking.appointmentStartAt, booking.appointmentTimezone)}
                  </span>
                </div>
                <p className="text-[11px] text-zinc-500">
                  Link sent {formatTime(booking.linkSentAt)} · confirmed{' '}
                  {formatTime(booking.confirmedAt)}
                  {booking.cancelledAt !== null &&
                    ` · cancelled ${formatTime(booking.cancelledAt)}`}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h4 className="mb-1 text-[11px] font-medium text-zinc-500">CRM / notification / handoff</h4>
        {m.deliveries.length === 0 ? (
          <p className="text-zinc-500">No deliveries.</p>
        ) : (
          <ul className="space-y-1">
            {m.deliveries.map((delivery) => (
              <li key={delivery.id} className="flex flex-wrap items-center gap-2">
                <span className="w-32 text-zinc-300">{humanize(delivery.destination)}</span>
                <StatusBadge
                  status={delivery.status}
                  tone={delivery.status === 'COMPLETED' ? 'emerald' : undefined}
                />
                <span className="text-[11px] text-zinc-500">
                  {humanize(delivery.eventType)} · {delivery.attempts} attempts
                  {delivery.lastErrorCode !== null && ` · ${delivery.lastErrorCode}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
