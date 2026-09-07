import PlacementDetailLoader from "./PlacementDetailLoader";

export const metadata = {
  title: "配置詳細 | geolia",
};

export default async function PlacementDetailPage({ params }) {
  const { id } = await params;
  return <PlacementDetailLoader id={id} />;
}
