/**
 * DumpsterMap Unit Tests
 * Run: npm test
 */

const { describe, it, expect, beforeAll, afterAll, beforeEach } = require('@jest/globals');

// Mock dependencies before requiring server
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn().mockResolvedValue({ messageId: 'test-id' })
  }))
}));

jest.mock('node-fetch', () => jest.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({})
}));

// Test utilities
const generateLeadId = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
};

const parseProviderIds = (notifiedStr) => {
  if (!notifiedStr) return [];
  const match = notifiedStr.match(/\[([\d,\s]*)\]/);
  if (match && match[1].trim()) {
    return match[1].split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  }
  return [];
};

const formatProviderIds = (ids) => `[${ids.join(', ')}]`;

describe('Lead ID Generation', () => {
  it('generates 6-character IDs', () => {
    const id = generateLeadId();
    expect(id.length).toBe(6);
  });

  it('uses only allowed characters (no ambiguous chars)', () => {
    const allowedChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let i = 0; i < 100; i++) {
      const id = generateLeadId();
      for (const char of id) {
        expect(allowedChars).toContain(char);
      }
    }
  });

  it('does not contain ambiguous characters (0, O, 1, I)', () => {
    for (let i = 0; i < 100; i++) {
      const id = generateLeadId();
      expect(id).not.toMatch(/[0O1I]/);
    }
  });
});

describe('Provider ID List Format', () => {
  describe('parseProviderIds', () => {
    it('parses single ID', () => {
      expect(parseProviderIds('[1]')).toEqual([1]);
    });

    it('parses multiple IDs', () => {
      expect(parseProviderIds('[1, 2, 3]')).toEqual([1, 2, 3]);
    });

    it('handles no spaces', () => {
      expect(parseProviderIds('[1,2,3]')).toEqual([1, 2, 3]);
    });

    it('handles extra spaces', () => {
      expect(parseProviderIds('[  1 ,  2 ,  3  ]')).toEqual([1, 2, 3]);
    });

    it('returns empty array for null/undefined', () => {
      expect(parseProviderIds(null)).toEqual([]);
      expect(parseProviderIds(undefined)).toEqual([]);
    });

    it('returns empty array for empty brackets', () => {
      expect(parseProviderIds('[]')).toEqual([]);
    });

    it('returns empty array for legacy format (no brackets)', () => {
      expect(parseProviderIds('Company A (full), Company B (teaser)')).toEqual([]);
    });
  });

  describe('formatProviderIds', () => {
    it('formats single ID', () => {
      expect(formatProviderIds([1])).toBe('[1]');
    });

    it('formats multiple IDs', () => {
      expect(formatProviderIds([1, 2, 3])).toBe('[1, 2, 3]');
    });

    it('formats empty array', () => {
      expect(formatProviderIds([])).toBe('[]');
    });
  });

  describe('ID merging (resend logic)', () => {
    it('merges new IDs with existing', () => {
      const existing = parseProviderIds('[1, 2]');
      const newIds = [2, 3, 4];
      const merged = [...new Set([...existing, ...newIds])];
      expect(merged).toEqual([1, 2, 3, 4]);
    });

    it('deduplicates IDs', () => {
      const existing = parseProviderIds('[1, 2, 3]');
      const newIds = [1, 2, 3];
      const merged = [...new Set([...existing, ...newIds])];
      expect(merged).toEqual([1, 2, 3]);
    });
  });
});

describe('ZIP Code Matching', () => {
  // Mock provider data for testing
  const mockProviders = [
    { id: 1, company_name: 'Provider A', zip_codes: '33901, 33902, 33903', credit_balance: 5, active: 1 },
    { id: 2, company_name: 'Provider B', zip_codes: '33901, 33904', credit_balance: 0, active: 1 },
    { id: 3, company_name: 'Provider C', zip_codes: '34101, 34102', credit_balance: 10, active: 1 },
    { id: 4, company_name: 'Inactive', zip_codes: '33901', credit_balance: 5, active: 0 },
  ];

  const getProvidersByZip = (zip) => {
    return mockProviders.filter(p => {
      if (!p.active) return false;
      const zips = p.zip_codes.split(',').map(z => z.trim());
      return zips.includes(zip);
    });
  };

  it('finds providers serving a ZIP', () => {
    const providers = getProvidersByZip('33901');
    expect(providers.length).toBe(2);
    expect(providers.map(p => p.company_name)).toEqual(['Provider A', 'Provider B']);
  });

  it('excludes inactive providers', () => {
    const providers = getProvidersByZip('33901');
    expect(providers.find(p => p.company_name === 'Inactive')).toBeUndefined();
  });

  it('returns empty array for unserved ZIP', () => {
    const providers = getProvidersByZip('99999');
    expect(providers).toEqual([]);
  });
});

describe('Credit Balance Logic', () => {
  it('identifies providers with sufficient credits', () => {
    const providers = [
      { id: 1, credit_balance: 5 },
      { id: 2, credit_balance: 0 },
      { id: 3, credit_balance: 1 },
    ];
    const creditCost = 1;
    
    const fullProviders = providers.filter(p => p.credit_balance >= creditCost);
    const teaserProviders = providers.filter(p => p.credit_balance < creditCost);
    
    expect(fullProviders.map(p => p.id)).toEqual([1, 3]);
    expect(teaserProviders.map(p => p.id)).toEqual([2]);
  });

  it('handles zero credit cost', () => {
    const providers = [{ id: 1, credit_balance: 0 }];
    const fullProviders = providers.filter(p => p.credit_balance >= 0);
    expect(fullProviders.length).toBe(1);
  });
});

describe('Lead Data Validation', () => {
  const validateLead = (data) => {
    const errors = [];
    if (!data.zip || !/^\d{5}$/.test(data.zip)) errors.push('Invalid ZIP');
    if (!data.phone || data.phone.replace(/\D/g, '').length < 10) errors.push('Invalid phone');
    if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) errors.push('Invalid email');
    return errors;
  };

  it('validates correct data', () => {
    expect(validateLead({ zip: '33901', phone: '239-555-1234', email: 'test@example.com' })).toEqual([]);
  });

  it('rejects invalid ZIP', () => {
    expect(validateLead({ zip: '1234', phone: '239-555-1234' })).toContain('Invalid ZIP');
    expect(validateLead({ zip: 'abcde', phone: '239-555-1234' })).toContain('Invalid ZIP');
  });

  it('rejects short phone', () => {
    expect(validateLead({ zip: '33901', phone: '555-1234' })).toContain('Invalid phone');
  });

  it('rejects invalid email format', () => {
    expect(validateLead({ zip: '33901', phone: '239-555-1234', email: 'notanemail' })).toContain('Invalid email');
  });

  it('allows missing email', () => {
    expect(validateLead({ zip: '33901', phone: '239-555-1234' })).toEqual([]);
  });
});

describe('Admin Display Helpers', () => {
  const getNotifiedDisplay = (notifiedStr, providers) => {
    if (!notifiedStr) return { count: 0, title: 'No providers notified' };
    
    const match = notifiedStr.match(/\[([\d,\s]*)\]/);
    if (match && match[1].trim()) {
      const ids = match[1].split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
      const names = ids.map(id => {
        const p = providers.find(prov => prov.id === id);
        return p ? p.company_name : `ID:${id}`;
      });
      return { count: ids.length, title: names.join(', ') };
    }
    
    // Legacy format
    return { count: notifiedStr.split(',').length, title: notifiedStr };
  };

  const mockProviders = [
    { id: 1, company_name: 'ABC Dumpsters' },
    { id: 2, company_name: 'XYZ Hauling' },
  ];

  it('displays new format correctly', () => {
    const result = getNotifiedDisplay('[1, 2]', mockProviders);
    expect(result.count).toBe(2);
    expect(result.title).toBe('ABC Dumpsters, XYZ Hauling');
  });

  it('handles unknown IDs', () => {
    const result = getNotifiedDisplay('[1, 99]', mockProviders);
    expect(result.title).toBe('ABC Dumpsters, ID:99');
  });

  it('handles legacy format', () => {
    const result = getNotifiedDisplay('ABC Dumpsters (full), XYZ (teaser)', mockProviders);
    expect(result.count).toBe(2);
    expect(result.title).toBe('ABC Dumpsters (full), XYZ (teaser)');
  });

  it('handles empty/null', () => {
    expect(getNotifiedDisplay(null, mockProviders).count).toBe(0);
    expect(getNotifiedDisplay('', mockProviders).count).toBe(0);
  });
});
