import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
}

interface UiState {
  searchModalOpen: boolean;
  scansRevealedFor: Record<string, boolean>;
  toasts: Toast[];
}

const initialState: UiState = {
  searchModalOpen: false,
  scansRevealedFor: {},
  toasts: [],
};

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    openSearchModal(state) {
      state.searchModalOpen = true;
    },
    closeSearchModal(state) {
      state.searchModalOpen = false;
    },
    toggleScansRevealed(state, action: PayloadAction<string>) {
      state.scansRevealedFor[action.payload] = !state.scansRevealedFor[action.payload];
    },
    hideScans(state, action: PayloadAction<string>) {
      state.scansRevealedFor[action.payload] = false;
    },
    pushToast(state, action: PayloadAction<Toast>) {
      state.toasts.push(action.payload);
    },
    dismissToast(state, action: PayloadAction<string>) {
      state.toasts = state.toasts.filter((t) => t.id !== action.payload);
    },
  },
});

export const {
  openSearchModal,
  closeSearchModal,
  toggleScansRevealed,
  hideScans,
  pushToast,
  dismissToast,
} = uiSlice.actions;

export default uiSlice.reducer;
