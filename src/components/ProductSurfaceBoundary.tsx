import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

interface ProductSurfaceBoundaryProps {
  readonly children: ReactNode;
  readonly surfaceName: string;
}

interface ProductSurfaceBoundaryState {
  readonly failed: boolean;
}

export function ProductSurfaceFallback({
  surfaceName,
  onRetry,
}: {
  readonly surfaceName: string;
  readonly onRetry?: () => void;
}) {
  return (
    <section
      className="flex h-full min-h-[280px] items-center justify-center overflow-y-auto bg-[#07090d] p-4"
      aria-label={`${surfaceName} unavailable`}
      role="alert"
    >
      <div className="w-full max-w-xl border border-amber/40 bg-amber/5 p-5 text-center">
        <AlertTriangle className="mx-auto text-amber" size={28} />
        <h1 className="mt-3 font-mono text-sm font-semibold tracking-wide text-ink">
          {surfaceName} is currently unavailable
        </h1>
        <p className="mt-2 text-xs leading-5 text-muted">
          The surface stopped before verified state could be presented. No canonical paper action, target weight, research status, or provider state was inferred from this failure.
        </p>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="mx-auto mt-4 flex items-center gap-2 border border-line bg-panel-2 px-3 py-2 font-mono text-[11px] text-cyan hover:border-cyan/50"
          >
            <RotateCcw size={13} /> Retry this view
          </button>
        ) : null}
      </div>
    </section>
  );
}

export class ProductSurfaceBoundary extends Component<
  ProductSurfaceBoundaryProps,
  ProductSurfaceBoundaryState
> {
  state: ProductSurfaceBoundaryState = { failed: false };

  static getDerivedStateFromError(): ProductSurfaceBoundaryState {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // The product UI intentionally exposes no raw exception or component stack.
  }

  private readonly retry = (): void => {
    this.setState({ failed: false });
  };

  render(): ReactNode {
    if (this.state.failed) {
      return <ProductSurfaceFallback surfaceName={this.props.surfaceName} onRetry={this.retry} />;
    }
    return this.props.children;
  }
}
