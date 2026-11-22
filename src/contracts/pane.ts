export interface PaneOptions {
  readonly label: string;
  readonly command: readonly string[];
  readonly cwd: string;
}

/** 每次打开得到独立的窗格句柄，由创建它的宿主等待和关闭。 */
export interface PaneHost<Pane> {
  /** 在指定工作目录启动命令，开窗失败时抛出。 */
  open(options: PaneOptions): Pane;
  /** 窗格关闭或其中的命令退出时结束等待。 */
  waitClosed(pane: Pane): Promise<void>;
  /** 关闭窗格并结束其中的命令。窗格已经关闭时直接返回。 */
  close(pane: Pane): void;
}
