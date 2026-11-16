export default function OmpWebLogo({
  size = 20,
  label = "key lime logo",
}: {
  size?: number;
  label?: string;
}) {
  return (
    <img
      src="/icon-192.png"
      width={size}
      height={size}
      alt={label}
      style={{ display: "block", flexShrink: 0 }}
    />
  );
}
