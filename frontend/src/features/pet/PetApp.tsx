import PetView from "./PetView";

/** 桌宠窗口的根：不挂主应用外壳，只渲染透明宠物层。 */
export default function PetApp(): JSX.Element {
  return <PetView />;
}
