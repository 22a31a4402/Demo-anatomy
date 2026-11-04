import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw, Trash2, ChevronDown, ChevronUp } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  showDetails: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
    showDetails: false,
  };

  public static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[NextGen Eval ErrorBoundary Caught Error]:', error, errorInfo);
    this.setState({ errorInfo });
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null, showDetails: false });
  };

  private handleReload = () => {
    window.location.reload();
  };

  private handleClearCacheAndReset = () => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      // Ignore storage clear errors
    }
    window.location.href = '/';
  };

  private toggleDetails = () => {
    this.setState((prev) => ({ showDetails: !prev.showDetails }));
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
          <div className="w-full max-w-xl bg-white border border-slate-200 rounded-2xl shadow-xl p-8 animate-fade-in">
            {/* Header / Brand */}
            <div className="flex items-center gap-3 mb-6 pb-6 border-b border-slate-100">
              <div className="w-12 h-12 rounded-xl bg-red-100 text-red-600 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div>
                <span className="text-[11px] font-black uppercase tracking-wider text-red-600 bg-red-50 px-2.5 py-0.5 rounded-full border border-red-200">
                  Interface Recovery Mode
                </span>
                <h1 className="text-xl font-black text-slate-900 mt-1">
                  NextGen <span className="text-red-600">Eval</span>
                </h1>
              </div>
            </div>

            {/* Error Message */}
            <div className="mb-6">
              <h2 className="text-base font-bold text-slate-800 mb-2">
                {this.props.fallbackTitle || 'An unexpected rendering error occurred'}
              </h2>
              <p className="text-sm text-slate-600 leading-relaxed">
                The interface encountered an unexpected state. Your grading configuration and backend evaluation service remain intact. You can try reloading or clearing temporary cached state.
              </p>
              {this.state.error && (
                <div className="mt-3 p-3 bg-red-50/70 border border-red-200 rounded-xl text-xs font-mono text-red-800 break-words">
                  {this.state.error.message || 'Unknown runtime error'}
                </div>
              )}
            </div>

            {/* Recovery Action Buttons */}
            <div className="flex flex-wrap items-center gap-3 mb-6">
              <button
                type="button"
                onClick={this.handleReload}
                className="flex-1 min-w-[140px] px-4 py-2.5 bg-slate-900 hover:bg-black text-white text-xs font-bold rounded-xl shadow-sm transition flex items-center justify-center gap-2 cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Reload App
              </button>
              <button
                type="button"
                onClick={this.handleReset}
                className="flex-1 min-w-[140px] px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold rounded-xl transition flex items-center justify-center gap-2 cursor-pointer"
              >
                Try Again
              </button>
              <button
                type="button"
                onClick={this.handleClearCacheAndReset}
                className="px-4 py-2.5 bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-bold rounded-xl transition flex items-center justify-center gap-2 border border-rose-200 cursor-pointer"
                title="Clears local browser storage and reloads to clean state"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear Local Data
              </button>
            </div>

            {/* Technical Diagnostics Accordion */}
            <div className="border-t border-slate-100 pt-4">
              <button
                type="button"
                onClick={this.toggleDetails}
                className="w-full flex items-center justify-between text-xs text-slate-400 hover:text-slate-600 font-semibold cursor-pointer"
              >
                <span>Diagnostic Details</span>
                {this.state.showDetails ? (
                  <ChevronUp className="w-4 h-4" />
                ) : (
                  <ChevronDown className="w-4 h-4" />
                )}
              </button>
              {this.state.showDetails && (
                <div className="mt-3 p-3 bg-slate-900 text-slate-200 rounded-xl text-[11px] font-mono overflow-auto max-h-48 leading-snug">
                  <div className="font-bold text-red-400 mb-1">
                    {this.state.error?.name}: {this.state.error?.message}
                  </div>
                  {this.state.error?.stack && (
                    <div className="text-slate-400 whitespace-pre-wrap">
                      {this.state.error.stack}
                    </div>
                  )}
                  {this.state.errorInfo?.componentStack && (
                    <div className="mt-2 text-slate-500 whitespace-pre-wrap border-t border-slate-800 pt-2">
                      {this.state.errorInfo.componentStack}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
