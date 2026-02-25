interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
}

export function StatCard({ label, value, sub }: StatCardProps) {
  return (
    <div className="bg-navy-900 border border-zinc-800 rounded p-4">
      <p className="text-xs uppercase tracking-wider text-zinc-500 mb-1">
        {label}
      </p>
      <p className="text-2xl font-mono text-white font-semibold">{value}</p>
      {sub && (
        <p className="text-sm text-zinc-400 mt-1">{sub}</p>
      )}
    </div>
  );
}
