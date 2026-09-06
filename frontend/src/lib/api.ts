import axios from 'axios';

let authRedirectInProgress = false;

// Base URL derived from window.location.origin so LAN clients connect to host IP.
const api = axios.create({
  baseURL: typeof window !== 'undefined' ? `${window.location.origin}/api` : '/api',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  },
});

// Attach JWT token to every request
api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  }
  return config;
});

// Handle 401 responses
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && typeof window !== 'undefined') {
      // KDS routes render inline login; avoid redirecting away to /auth/login.
      const isKdsPath = window.location.pathname.startsWith('/kds');
      localStorage.removeItem('token');
      if (isKdsPath) return Promise.reject(error);
      // Don't redirect when already on the login page — let the login handler show the error
      if (!window.location.pathname.includes('/auth/login') && !authRedirectInProgress) {
        authRedirectInProgress = true;
        localStorage.removeItem('tenant');
        window.location.href = '/auth/login';
      }
    }
    return Promise.reject(error);
  }
);

export default api;
