import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};
const app = initializeApp(config);
export const auth = getAuth(app);

export function apiUrl(path: string): string {
  const configured = import.meta.env.VITE_API_BASE_URL;
  const base = typeof configured === "string" && configured.trim() ? configured.trim() : "http://localhost:8080";
  return `${base.replace(/\/$/, "")}${path}`;
}
