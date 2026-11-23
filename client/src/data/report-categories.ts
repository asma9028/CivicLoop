import type { Category } from '../types';

export const reportCategories: { id: Category; label: string }[] = [
  { id: 'ROAD', label: 'Roads & Potholes' },
  { id: 'WASTE', label: 'Garbage & Sanitation' },
  { id: 'WATER', label: 'Water Supply' },
  { id: 'DRAINAGE', label: 'Drainage & Flooding' },
  { id: 'ELECTRICITY', label: 'Streetlights & Electricity' },
  { id: 'PUBLIC_SPACE', label: 'Parks & Public Spaces' },
  { id: 'OTHER', label: 'Other / Public Infrastructure' },
];
