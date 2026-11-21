#!/usr/bin/env node
// Seed the staging Supabase database with fake data.
// Usage: SUPABASE_PROJECT_REF=<ref> SUPABASE_ACCESS_TOKEN=<token> npm run seed:staging
//
// Idempotent: safe to run multiple times. Wipes and re-seeds from scratch.
// Seed order matches the migration's cascade delete order so constraints
// (child enrollment limits, foreign keys) are never violated.

import { createClient } from '@supabase/supabase-js';

if (!process.env.SUPABASE_PROJECT_REF) {
  throw new Error('SUPABASE_PROJECT_REF must be set');
}
if (!process.env.SUPABASE_ACCESS_TOKEN) {
  throw new Error('SUPABASE_ACCESS_TOKEN must be set');
}

const ref = process.env.SUPABASE_PROJECT_REF;
const token = process.env.SUPABASE_ACCESS_TOKEN;
const url = `https://${ref}.supabase.co`;

// Use the service role key for seeding (bypasses RLS, runs as admin).
// In CI this is provided as SUPABASE_ACCESS_TOKEN (the actual service key).
const client = createClient(url, token, {
  auth: { persistSession: false, autoRefreshToken: false },
});

console.log(`Seeding staging database: ${url}`);

// Helper: retry a query up to 5 times on network errors (ECONNRESET, ETIMEDOUT).
// Supabase API rate limits in CI can cause transient failures.
async function withRetry(fn, label, maxAttempts = 5) {
  let attempt = 1;
  while (true) {
    try {
      const result = await fn();
      if (attempt > 1) {
        console.log(`[${label}] succeeded on attempt ${attempt}`);
      }
      return result;
    } catch (err) {
      if (attempt >= maxAttempts) {
        throw new Error(`[${label}] failed after ${attempt} attempts: ${err.message}`);
      }
      console.log(`[${label}] attempt ${attempt} failed: ${err.message} — retrying in 3s`);
      attempt++;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// Helper: delete all rows from a table.
async function truncate(table) {
  console.log(`  Truncating ${table}...`);
  await withRetry(
    () => client.from(table).delete().neq('id', ''),
    `${table}.truncate`,
  );
}

async function insert(table, rows) {
  console.log(`  Inserting ${rows.length} row(s) into ${table}`);
  await withRetry(
    () => client.from(table).insert(rows),
    `${table}.insert`,
  );
}

async function seedAll() {
  // Wipe everything (idempotent).
  console.log('=== Phase 1: Clear existing data ===');
  await truncate('enrollment_requests');
  await truncate('enrollments');
  await truncate('dues_statuses');
  await truncate('document_submissions');
  await truncate('requirements');
  await truncate('teacher_assignments');
  await truncate('class_terms');
  await truncate('events');
  await truncate('children');
  await truncate('enrollment_periods');
  await truncate('academic_terms');
  await truncate('class_blocks');
  await truncate('classes');
  await truncate('families');
  await truncate('profiles');
  await truncate('school_years');
  await truncate('audit_log');

  // Phase 2: Seed data.
  console.log('=== Phase 2: Seed data ===');

  // 1. School year.
  const yearId = crypto.randomUUID();
  await insert('school_years', [{
    id: yearId,
    label: '2026-27',
    starts_on: '2026-08-15',
    ends_on: '2027-06-15',
    is_current: true,
  }]);

  // 2. Enrollment period (active, for the school year).
  const enrollmentId = crypto.randomUUID();
  await insert('enrollment_periods', [{
    id: enrollmentId,
    school_year_id: yearId,
    title: 'Fall 2026 Enrollment',
    opens_at: '2026-07-01T00:00:00Z',
    closes_at: '2026-08-01T23:59:59Z',
    active: true,
    electives_only: false,
  }]);

  // 3. Academic term.
  const termId = crypto.randomUUID();
  await insert('academic_terms', [{
    id: termId,
    school_year_id: yearId,
    label: 'Fall Semester',
    starts_on: '2026-08-15',
    ends_on: '2026-12-20',
    sort_order: 1,
  }]);

  // 4. Class block (morning).
  const blockId = crypto.randomUUID();
  await insert('class_blocks', [{
    id: blockId,
    school_year_id: yearId,
    label: 'Morning Block A',
    starts_at: '08:00:00',
    ends_at: '09:30:00',
    sort_order: 1,
    day_of_week: 1, // Monday
  }]);

  // 5. Classes (one per grade for ages 2-8, plus one high school elective).
  const classRows = [];
  const classIds = {};
  for (let age = 2; age <= 8; age++) {
    const id = crypto.randomUUID();
    classIds[`age-${age}`] = id;
    classRows.push({
      id,
      school_year_id: yearId,
      title: `Ages ${age} Class`,
      description: `Preschool class for children age ${age}.`,
      term: termId,
      block_id: blockId,
      room_id: null,
      active: true,
      is_demo: false,
      is_elective: false,
      grades: [String(age)],
      capacity: 12,
      created_at: '2026-06-01T00:00:00Z',
      updated_at: '2026-06-01T00:00:00Z',
    });
  }
  // High school elective.
  const hsClassId = crypto.randomUUID();
  classIds['hs-elective'] = hsClassId;
  classRows.push({
    id: hsClassId,
    school_year_id: yearId,
    title: 'Intro to AI (HS Elective)',
    description: 'High school elective: introduction to artificial intelligence.',
    term: termId,
    block_id: blockId,
    room_id: null,
    active: true,
    is_demo: false,
    is_elective: true,
    grades: [],
    capacity: 20,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
  });
  await insert('classes', classRows);

  // 6. Families (parents only, for now).
  const smithFamilyId = crypto.randomUUID();
  const smithParentIds = [crypto.randomUUID(), crypto.randomUUID()];
  await insert('families', [{
    id: smithFamilyId,
    display_name: 'The Smiths',
    parents: [{ id: smithParentIds[0] }, { id: smithParentIds[1] }],
    primary_address: '123 Oak Street, San Francisco, CA 94110',
    return_address: '123 Oak Street, San Francisco, CA 94110',
    return_status: true,
    status_note: 'Returning family.',
  }]);

  const johnsonFamilyId = crypto.randomUUID();
  const johnsonParentIds = [crypto.randomUUID()];
  await insert('families', [{
    id: johnsonFamilyId,
    display_name: 'The Johnsons',
    parents: [{ id: johnsonParentIds[0] }],
    primary_address: '456 Maple Ave, San Francisco, CA 94111',
    return_address: '456 Maple Ave, San Francisco, CA 94111',
    return_status: true,
    status_note: 'Returning family.',
  }]);

  const notReturningFamilyId = crypto.randomUUID();
  await insert('families', [{
    id: notReturningFamilyId,
    display_name: 'The Garcias',
    parents: [{ id: crypto.randomUUID() }],
    primary_address: '789 Pine St, San Francisco, CA 94112',
    return_address: null,
    return_status: false,
    status_note: 'Not returning.',
  }]);

  // 7. Children.
  const smithKids = [];
  smithKids.push({ family_id: smithFamilyId, age: 5, name: 'Emma Smith', grade: '5' });
  smithKids.push({ family_id: smithFamilyId, age: 2, name: 'Leo Smith', grade: '2' });

  const johnsonKids = [];
  johnsonKids.push({ family_id: johnsonFamilyId, age: 7, name: 'Mia Johnson', grade: '7' });

  const notReturningKids = [];
  notReturningKids.push({ family_id: notReturningFamilyId, age: 4, name: 'Carlos Garcia', grade: '4' });

  const allKids = [...smithKids, ...johnsonKids, ...notReturningKids];
  const childRows = [];
  for (const kid of allKids) {
    childRows.push({
      id: crypto.randomUUID(),
      first_name: kid.name.split(' ')[0],
      last_name: kid.name.split(' ')[1],
      age: kid.age,
      birthdate: null,
      gender: null,
      grade: kid.grade,
      school_year_id: yearId,
      family_id: kid.family_id,
      teacher_id: null,
      active: true,
      enrollment_status: 'enrolled',
    });
  }
  await insert('children', childRows);

  // 8. Teacher.
  const teacherProfileId = crypto.randomUUID();
  const teacherId = crypto.randomUUID();
  await insert('profiles', [{
    id: teacherProfileId,
    user_id: teacherId,
    email: 'teacher@example.com',
    display_name: 'Ms. Jane Teacher',
    email_verified: true,
    role: 'teacher',
    active: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }]);

  // 9. Enrollments.
  const enrollRows = [];
  for (const kid of allKids) {
    const childRow = childRows.find(r => r.first_name === kid.name.split(' ')[0] && r.last_name === kid.name.split(' ')[1]);
    const classId = classIds[`age-${kid.age}`];
    enrollRows.push({
      id: crypto.randomUUID(),
      class_id: classId,
      child_id: childRow.id,
      status: 'active',
      enrolled_at: '2026-07-15T00:00:00Z',
    });
  }
  await insert('enrollments', enrollRows);

  // 10. Enrollment requests (one parent requesting a HS elective for their kid).
  const hsKid = smithKids[0];
  const hsChildRow = childRows.find(r => r.first_name === hsKid.name.split(' ')[0]);
  await insert('enrollment_requests', [{
    id: crypto.randomUUID(),
    enrollment_period_id: enrollmentId,
    class_id: classIds['hs-elective'],
    child_id: hsChildRow.id,
    status: 'pending',
    requested_at: '2026-07-20T00:00:00Z',
  }]);

  // 11. Teacher assignment.
  await insert('teacher_assignments', [{
    id: crypto.randomUUID(),
    class_id: classIds['age-5'],
    user_id: teacherId,
    assignment_role: 'lead',
  }]);

  // 12. Requirements (two docs, two dues).
  const docReqId = crypto.randomUUID();
  await insert('requirements', [{
    id: docReqId,
    school_year_id: yearId,
    kind: 'document',
    title: 'Physical Exam',
    description: 'Annual physical exam form.',
    active: true,
    sort_order: 1,
    document_id: null,
    sign_template_id: null,
  }]);

  const duesReqId = crypto.randomUUID();
  await insert('requirements', [{
    id: duesReqId,
    school_year_id: yearId,
    kind: 'dues',
    title: 'Fall Tuition',
    description: 'Tuition for the fall semester.',
    active: true,
    sort_order: 2,
    amount_per_family: 500,
    amount_per_child: 100,
    payment_url: 'https://example.com/pay',
  }]);

  // 13. Document submission (one kid has their physical).
  await insert('document_submissions', [{
    id: crypto.randomUUID(),
    requirement_id: docReqId,
    family_id: smithFamilyId,
    child_id: hsChildRow.id,
    status: 'submitted',
    submitted_at: '2026-07-25T00:00:00Z',
    document_url: 'https://example.com/physical.pdf',
  }]);

  // 14. Dues status (paid and unpaid).
  await insert('dues_statuses', [{
    id: crypto.randomUUID(),
    requirement_id: duesReqId,
    family_id: smithFamilyId,
    child_id: hsChildRow.id,
    amount_due: 600,
    status: 'paid',
  }]);
  await insert('dues_statuses', [{
    id: crypto.randomUUID(),
    requirement_id: duesReqId,
    family_id: johnsonFamilyId,
    child_id: childRows.find(r => r.first_name === 'Mia').id,
    amount_due: 600,
    status: 'unpaid',
  }]);

  // 15. Event.
  await insert('events', [{
    id: crypto.randomUUID(),
    school_year_id: yearId,
    title: 'Fall Parent-Teacher Night',
    description: 'Meet your child\'s teacher.',
    start_at: '2026-09-15T18:00:00Z',
    end_at: '2026-09-15T20:00:00Z',
    location: 'Main Hall',
  }]);

  console.log('');
  console.log('=== Seed complete ===');
  console.log(`  School year: 2026-27 (${yearId})`);
  console.log(`  Classes: ${classRows.length}`);
  console.log(`  Families: 3 (2 returning, 1 not)`);
  console.log(`  Children: ${childRows.length}`);
  console.log(`  Enrollments: ${enrollRows.length}`);
  console.log(`  Enrollment requests: 1`);
  console.log(`  Teacher assignments: 1`);
  console.log(`  Requirements: 2`);
  console.log(`  Document submissions: 1`);
  console.log(`  Dues statuses: 2`);
  console.log(`  Events: 1`);
}

seedAll().catch(err => {
  console.error(`Seed failed: ${err.message}`);
  process.exit(1);
});