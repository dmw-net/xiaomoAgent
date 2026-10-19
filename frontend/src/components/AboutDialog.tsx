import Modal from "./Modal";
import AboutBody from "./AboutBody";

/** 关于弹窗：遮罩、Esc、点外层、焦点陷阱与初始/归还焦点一律由 <Modal> 负责。 */
export default function AboutDialog({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <Modal onClose={onClose} label="关于小茉" className="about-card">
      <AboutBody />
      <button type="button" id="aboutClose" className="primary" onClick={onClose}>关闭</button>
    </Modal>
  );
}
