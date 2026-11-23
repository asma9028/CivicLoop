export type Category = 'ROAD' | 'WASTE' | 'WATER' | 'DRAINAGE' | 'ELECTRICITY' | 'PUBLIC_SPACE' | 'OTHER';
export type Status = 'REPORTED' | 'ACKNOWLEDGED' | 'IN_PROGRESS' | 'RESOLUTION_SUBMITTED' | 'VERIFICATION_PENDING' | 'RESOLVED' | 'REOPENED' | 'ON_HOLD' | 'REJECTED' | 'DUPLICATE';
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface Incident {
  id: string;
  title: string;
  description: string;
  category: Category;
  status: Status;
  severity: Severity;
  address: string;
  latitude: number;
  longitude: number;
  reportedAt: string;
  department: string;
  resolution?: string;
  image?: string;
}
