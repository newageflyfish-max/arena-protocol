import type { ReactNode } from 'react';

interface DataTableProps {
  headers: string[];
  rows: ReactNode[][];
  onRowClick?: (index: number) => void;
}

export function DataTable({ headers, rows, onRowClick }: DataTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-navy-800">
            {headers.map((header) => (
              <th
                key={header}
                className="text-left text-xs uppercase tracking-wider text-zinc-400 px-4 py-3 border-b border-zinc-800 font-medium"
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={headers.length}
                className="px-4 py-8 text-center text-zinc-500 text-sm"
              >
                No data available
              </td>
            </tr>
          ) : (
            rows.map((row, rowIdx) => (
              <tr
                key={rowIdx}
                className={`border-b border-zinc-800/50 bg-navy-900 hover:bg-navy-800 transition-colors ${
                  onRowClick ? 'cursor-pointer' : ''
                }`}
                onClick={() => onRowClick?.(rowIdx)}
              >
                {row.map((cell, cellIdx) => (
                  <td key={cellIdx} className="px-4 py-3 text-sm">
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
