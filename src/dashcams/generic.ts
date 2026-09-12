/** Portable interchange naming; recording time is explicit, never inferred from upload time. */
export function parseGenericFilename(name: string) {
  const match =
    /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_([FR])(?:_(\d{1,6}))?\.(mp4|mov|ts)$/i.exec(name);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, camera, sequence = "0", ext] = match;
  const stamp = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
  const epoch = Date.parse(stamp);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== stamp) return null;
  return {
    epoch: epoch / 1000,
    camera: camera!.toUpperCase() as "F" | "R",
    sequence: Number(sequence),
    base: `GEN${year}${month}${day}_${hour}${minute}${second}_${sequence}`,
    filename: name,
    peer: name.replace(/_F(?=(_\d+)?\.)/i, "_R"),
    ext: ext!.toLowerCase(),
  };
}
