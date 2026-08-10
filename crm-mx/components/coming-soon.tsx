export function ComingSoon({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="p-6">
      <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
      <div className="mt-4 rounded-lg border border-dashed p-10 text-center">
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}
