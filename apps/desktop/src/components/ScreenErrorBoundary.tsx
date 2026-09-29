import { Component, type ReactNode } from "react";

interface ScreenErrorBoundaryProps {
  /** Changing the key (for example the active page) clears a caught error. */
  resetKey: string;
  children: ReactNode;
}

interface ScreenErrorBoundaryState {
  failedKey: string | null;
}

/**
 * Contains a rendering failure to the current screen. Without it, one
 * unexpected value (for example a malformed engine timestamp) unmounted the
 * whole application and left an empty window.
 */
export class ScreenErrorBoundary extends Component<ScreenErrorBoundaryProps, ScreenErrorBoundaryState> {
  state: ScreenErrorBoundaryState = { failedKey: null };

  static getDerivedStateFromError(): Partial<ScreenErrorBoundaryState> {
    return { failedKey: "__pending__" };
  }

  componentDidCatch(): void {
    this.setState({ failedKey: this.props.resetKey });
  }

  render(): ReactNode {
    const { failedKey } = this.state;
    const failed = failedKey !== null && (failedKey === "__pending__" || failedKey === this.props.resetKey);
    if (!failed) return this.props.children;
    return (
      <div className="page screen-error" role="alert">
        <p className="section-kicker">EKRAN AÇILAMADI</p>
        <h1>Bu ekran beklenmeyen bir veriyle karşılaştı.</h1>
        <p>
          Yerel verin değişmedi. Ekranı yeniden deneyin; sorun sürerse Operasyonlar ekranından
          sır içermeyen bir tanı paketi oluşturun.
        </p>
        <button className="button button-primary" type="button" onClick={() => this.setState({ failedKey: null })}>
          Ekranı yeniden dene
        </button>
      </div>
    );
  }
}
