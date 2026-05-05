export function Loading({ what = 'loading' }: { what?: string }) {
  return <p className="text-sm text-slate-500 italic">{what}…</p>;
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="bg-red-950/40 border border-red-900/60 rounded-md p-3 text-sm text-red-300">
      {message}
    </div>
  );
}
