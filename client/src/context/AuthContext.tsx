import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { apiRequest } from '../services/api';

export type UserRole = 'CITIZEN' | 'AUTHORITY' | 'ADMIN';
export interface AuthUser {
  id: string;
  fullName: string;
  email: string;
  phoneNumber: string | null;
  role: UserRole;
  accountStatus: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<AuthUser>;
  register: (fullName: string, email: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  updateProfile: (values: { fullName?: string; phoneNumber?: string | null }) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user,setUser]=useState<AuthUser|null>(null);
  const [loading,setLoading]=useState(true);

  const refresh=useCallback(async()=>{
    try {
      const body=await apiRequest<{ user: AuthUser }>('/api/auth/me');
      setUser(body.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  },[]);

  useEffect(()=>{
    let active=true;
    void (async()=>{
      try {
        const body=await apiRequest<{ user: AuthUser }>('/api/auth/me');
        if(active) setUser(body.user);
      } catch {
        if(active) setUser(null);
      } finally {
        if(active) setLoading(false);
      }
    })();
    return ()=>{active=false};
  },[]);

  const login=useCallback(async(email:string,password:string)=>{
    const body=await apiRequest<{ user: AuthUser }>('/api/auth/login',{method:'POST',body:JSON.stringify({email,password})});
    setUser(body.user);
    return body.user as AuthUser;
  },[]);
  const register=useCallback(async(fullName:string,email:string,password:string)=>{
    const body=await apiRequest<{ user: AuthUser }>('/api/auth/register',{method:'POST',body:JSON.stringify({fullName,email,password})});
    setUser(body.user);
    return body.user as AuthUser;
  },[]);
  const logout=useCallback(async()=>{
    await apiRequest<{ success: boolean }>('/api/auth/logout',{method:'POST',body:'{}'});
    setUser(null);
  },[]);
  const updateProfile=useCallback(async(values:{fullName?:string;phoneNumber?:string|null})=>{
    const body=await apiRequest<{ user: AuthUser }>('/api/users/me',{method:'PATCH',body:JSON.stringify(values)});
    setUser(body.user);
  },[]);

  const value=useMemo(()=>({user,loading,login,register,logout,refresh,updateProfile}),[user,loading,login,register,logout,refresh,updateProfile]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context=useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
