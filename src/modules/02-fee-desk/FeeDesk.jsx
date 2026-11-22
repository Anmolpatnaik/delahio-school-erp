import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  ChevronRight,
  Filter,
  IndianRupee,
  Printer,
  Receipt,
  Search,
  Send,
  Wallet,
  X,
} from 'lucide-react';
import { calculateStudentDues, formatINR, round2 } from '../../core/currencyMath';
import { can } from '../../core/permissions';
import { postBulkRemind, postPayment, postWaiveFine } from '../../core/api';
import { recordAudit } from '../../core/auditLogger';

const CLASS_OPTIONS = ['ALL', '8', '9', '10', '12'];

const STATUS_OPTIONS = [
  { id: 'ALL', label: 'All students' },
  { id: 'OVERDUE', label: 'Overdue' },
  { id: 'CLEARED', label: 'Cleared' },
  { id: 'CREDIT', label: 'Credit balance' },
];





export default function FeeDesk({ students, school, role, onAudit, onToast, onPaymentSuccess }) {
  const [rows, setRows] = useState(students);
  const [query, setQuery] = useState('');
  const [classFilter, setClassFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [selected, setSelected] = useState(new Set());

  const [activeId, setActiveId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [form, setForm] = useState({ cash: '', upi: '', discount: '', waiveFine: false, note: '', waiverReason: '' });

  useEffect(() => {
    setRows(students);
  }, [students]);

  const visibleRows = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return rows.filter((student) => {
      if (classFilter !== 'ALL' && student.className !== classFilter) return false;

      const { pending } = calculateStudentDues(student);
      if (statusFilter === 'OVERDUE' && pending <= 0) return false;
      if (statusFilter === 'CLEARED' && pending !== 0) return false;
      if (statusFilter === 'CREDIT' && pending >= 0) return false;

      if (!needle) return true;
      return [student.name, student.id, student.parentName, student.phone].join(' ').toLowerCase().includes(needle);
    });
  }, [rows, query, classFilter, statusFilter]);

  useEffect(() => {
    setSelected((prev) => {
      const visibleIds = new Set(visibleRows.map((s) => s.id));
      const pruned = new Set([...prev].filter((id) => visibleIds.has(id)));
      return pruned.size === prev.size ? prev : pruned;
    });
  }, [visibleRows]);

  const active = rows.find((student) => student.id === activeId) ?? null;

  const pendingBook = rows.reduce((total, student) => total + calculateStudentDues(student).pending, 0);
  const defaulters = rows.filter((student) => calculateStudentDues(student).pending > 0).length;

  const columns = [
    { key: 'select', label: '' },
    { key: 'student', label: 'Student' },
    { key: 'class', label: 'Class' },
    { key: 'phone', label: 'Parent Phone' },
    { key: 'pending', label: 'Amount Due' },
    { key: 'status', label: 'Status' },
    { key: 'action', label: 'Action' },
  ];



  function toggleRow(id) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (visibleRows.length > 0 && visibleRows.every((s) => selected.has(s.id))) {
      setSelected((prev) => {
        const next = new Set(prev);
        visibleRows.forEach((s) => next.delete(s.id));
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        visibleRows.forEach((s) => next.add(s.id));
        return next;
      });
    }
  }

  function openStudent(student) {
    setActiveId(student.id);
  }

  function optimisticApply(studentId, cash, upi, waiveFine) {
    const delta = Number(cash || 0) + Number(upi || 0);
    setRows((previous) =>
      previous.map((row) =>
        row.id === studentId
          ? {
            ...row,
            paidAmount: row.paidAmount + delta,
            lateFine: waiveFine ? 0 : row.lateFine,
          }
          : row,
      ),
    );
  }

  async function collect(student, payload) {
    setBusyId(student.id);
    try {
      const result = await postPayment({
        studentId: student.id,
        cash: payload.cash,
        upi: payload.upi,
        discount: payload.discount,
        note: payload.note,
        role,
      });

      // Synchronize canonical server state across App, Fee Desk, and sibling modules
      if (onPaymentSuccess && result.student) {
        onPaymentSuccess({ student: result.student, receipt: result.receipt });
      }

      if (payload.waiveFine && student.lateFine > 0) {
        await postWaiveFine({
          studentId: student.id,
          role,
          reason: payload.waiverReason?.trim() || form.waiverReason?.trim() || 'Waived during fee payment',
        });
      }

      onToast(`${student.name}: receipt ${result.receipt.receiptNo} generated`);
      setForm({ cash: '', upi: '', discount: '', waiveFine: false, note: '', waiverReason: '' });
    } catch (error) {
      onToast(error.message, 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function waiveFine(student) {
    if (!form.waiverReason.trim()) {
      onToast('Please enter a written reason to waive late fine.', 'error');
      return;
    }
    setBusyId(student.id);
    try {
      const result = await postWaiveFine({
        studentId: student.id,
        role,
        reason: form.waiverReason.trim(),
      });
      setRows((previous) => previous.map((row) => (row.id === student.id ? { ...row, lateFine: 0 } : row)));
      if (onPaymentSuccess && result.student) {
        onPaymentSuccess({ student: result.student });
      }
      if (result.auditEntry && onAudit) {
        onAudit(result.auditEntry);
      }
      onToast(result.waived > 0 ? `Fine waived: ${formatINR(result.waived)}` : 'No fine pending on this student');
      setForm((prev) => ({ ...prev, waiveFine: false, waiverReason: '' }));
    } catch (error) {
      onToast(error.message, 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function remind(student) {
    try {
      await postBulkRemind({ studentIds: [student.id], role });
      onToast(`Reminder queued for ${student.parentName}`);
    } catch (error) {
      onToast(error.message, 'error');
    }
  }

  async function remindSelected() {
    try {
      const result = await postBulkRemind({ studentIds: [...selected], role });
      const entry = await recordAudit({
        action: 'BULK_REMIND',
        detail: `Reminder queued for ${result.sent} selected student(s)`,
        role,
      });
      onAudit(entry);
      onToast(`Reminder queued for ${result.sent} student(s)`);
    } catch (error) {
      onToast(error.message, 'error');
    }
  }


  function submitDetailPayment(student) {
    return collect(student, {
      cash: form.cash,
      upi: form.upi,
      discount: form.discount,
      waiveFine: form.waiveFine,
      note: form.note,
    });
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-5 py-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <Wallet className="h-4 w-4 text-brand-600" />
              Fee Desk
            </h2>
            <p className="text-[11px] text-slate-500">
              {school.branch} · collections open for {school.academicYear} · operator {role}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1.5 h-3.5 w-3.5 text-slate-400" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search student, parent or phone"
                className="erp-input w-60 pl-7"
              />
            </div>
            <div className="flex items-center gap-1 text-slate-400">
              <Filter className="h-3.5 w-3.5" />
            </div>
            <select value={classFilter} onChange={(event) => setClassFilter(event.target.value)} className="erp-input w-28">
              {CLASS_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option === 'ALL' ? 'All classes' : `Class ${option}`}
                </option>
              ))}
            </select>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="erp-input w-36">
              {STATUS_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Pending book</p>
            <p className="text-lg font-semibold text-slate-800">{`\u20B9${pendingBook.toLocaleString('en-IN')}`}</p>
          </div>
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-rose-600">Defaulters</p>
            <p className="text-lg font-semibold text-rose-700">{defaulters}</p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Students on desk</p>
            <p className="text-lg font-semibold text-slate-800">{rows.length}</p>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Selected</p>
              <p className="text-lg font-semibold text-slate-800">{selected.size}</p>
            </div>
            <button
              type="button"
              onClick={remindSelected}
              disabled={selected.size === 0}
              className="flex items-center gap-1.5 rounded-md bg-brand-600 px-2.5 py-1.5 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              <Send className="h-3.5 w-3.5" />
              Remind
            </button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto border-y border-slate-200 bg-white">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="sticky top-0 z-10 bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 shadow-sm">
            <tr>
              <th className="w-10 border-b border-slate-200 px-3 py-2.5">
                <input
                  type="checkbox"
                  aria-label="Select all students"
                  checked={visibleRows.length > 0 && visibleRows.every((s) => selected.has(s.id))}
                  onChange={toggleAll}
                  className="h-3.5 w-3.5 rounded border-slate-300"
                />
              </th>
              <th className="border-b border-slate-200 px-3 py-2.5 font-semibold">Student</th>
              <th className="border-b border-slate-200 px-3 py-2.5 font-semibold">Class</th>
              <th className="border-b border-slate-200 px-3 py-2.5 font-semibold">Parent Phone</th>
              <th className="border-b border-slate-200 px-3 py-2.5 text-right font-semibold">Amount Due</th>
              <th className="border-b border-slate-200 px-3 py-2.5 text-center font-semibold">Status</th>
              <th className="border-b border-slate-200 px-3 py-2.5 text-right font-semibold">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visibleRows.map((student) => {
              const rowDues = calculateStudentDues(student);
              const isSelected = selected.has(student.id);

              return (
                <tr
                  key={student.id}
                  className={`transition-colors ${isSelected ? 'bg-brand-50/60' : activeId === student.id ? 'bg-slate-100/70' : 'hover:bg-slate-50'
                    }`}
                >
                  <td className="px-3 py-2.5">
                    <input
                      type="checkbox"
                      aria-label={`Select ${student.name}`}
                      checked={isSelected}
                      onChange={() => toggleRow(student.id)}
                      className="h-3.5 w-3.5 rounded border-slate-300"
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <p className="max-w-[220px] truncate font-semibold leading-tight text-slate-800" title={student.name}>
                      {student.name}
                    </p>
                    <p className="text-[10px] text-slate-400">{student.id} · Roll {student.rollNo}</p>
                  </td>
                  <td className="px-3 py-2.5 text-slate-600">
                    Class {student.className}-{student.section}
                  </td>
                  <td className="px-3 py-2.5 text-slate-600">
                    <p>{student.phone}</p>
                    <p className="text-[10px] text-slate-400">{student.parentName}</p>
                  </td>
                  <td className="px-3 py-2.5 text-right font-semibold">
                    {rowDues.pending < 0 ? (
                      <span className="text-violet-600">
                        Credit ₹{Math.abs(rowDues.pending).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    ) : rowDues.pending === 0 ? (
                      <span className="text-emerald-600">₹0.00</span>
                    ) : (
                      <span className="text-rose-600">{formatINR(rowDues.pending)}</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    {rowDues.pending < 0 ? (
                      <span className="inline-flex rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-700">
                        Credit
                      </span>
                    ) : rowDues.pending === 0 ? (
                      <span className="inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                        Cleared
                      </span>
                    ) : (
                      <span className="inline-flex rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-medium text-rose-700">
                        Overdue
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <button
                      type="button"
                      onClick={() => openStudent(student)}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50 hover:text-brand-600"
                    >
                      {rowDues.pending <= 0 ? 'View' : 'Collect'}
                      <ChevronRight className="h-3 w-3" />
                    </button>
                  </td>
                </tr>
              );
            })}

            {visibleRows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-sm text-slate-400">
                  No fee rows match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="shrink-0 border-t border-slate-200 bg-slate-50 px-5 py-1.5 text-[11px] text-slate-500">
        Showing {visibleRows.length} of {rows.length} students · {selected.size} selected · fine waivers are audited
      </div>

      {active && (
        <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/40">
          <aside className="flex h-full w-[520px] flex-col bg-white shadow-2xl">
                       <div className="shrink-0 border-b border-slate-200 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    {active.id} · {active.feePlan}
                  </p>
                  <h3 className="truncate text-sm font-semibold leading-tight text-slate-900" title={active.name}>
                    {active.name}
                  </h3>
                  <p className="truncate text-[11px] text-slate-500">
                    Class {active.className}{active.section} · Roll {active.rollNo} · {active.parentName} · {active.phone}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveId(null)}
                  className="rounded-md border border-slate-200 p-1 text-slate-500 hover:bg-slate-100"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto min-h-0 px-4 py-3">
              <p className="rounded-md bg-slate-50 px-2 py-1.5 text-[11px] leading-snug text-slate-600">{active.address}</p>

              <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
                <div className="rounded-md border border-slate-200 px-2 py-1.5">
                  <p className="text-slate-500">Base tuition</p>
                  <p className="font-semibold text-slate-800">{formatINR(active.tuition)}</p>
                </div>
                <div className="rounded-md border border-slate-200 px-2 py-1.5">
                  <p className="text-slate-500">Scholarship</p>
                  <p className="font-semibold text-slate-800">
                    {active.scholarshipPct}% ({formatINR((active.tuition * active.scholarshipPct) / 100)})
                  </p>
                </div>
                <div className="rounded-md border border-slate-200 px-2 py-1.5">
                  <p className="text-slate-500">Late fine</p>
                  <p className="font-semibold text-slate-800">{formatINR(active.lateFine)}</p>
                </div>
                <div className="rounded-md border border-slate-200 px-2 py-1.5">
                  <p className="text-slate-500">Paid to date</p>
                  <p className="font-semibold text-slate-800">{formatINR(active.paidAmount)}</p>
                </div>
                <div className={`col-span-2 rounded-md border px-2 py-1.5 ${calculateStudentDues(active).pending < 0 ? 'border-violet-200 bg-violet-50' : 'border-rose-200 bg-rose-50'}`}>
                  <p className={calculateStudentDues(active).pending < 0 ? 'text-violet-600' : 'text-rose-600'}>
                    {calculateStudentDues(active).pending < 0 ? 'Credit / Refund Due' : 'Pending balance'}
                  </p>
                  <p className={`text-sm font-semibold ${calculateStudentDues(active).pending < 0 ? 'text-violet-700' : 'text-rose-700'}`}>
                    {calculateStudentDues(active).pending < 0
                      ? `₹${Math.abs(calculateStudentDues(active).pending).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                      : formatINR(calculateStudentDues(active).pending)}
                  </p>
                </div>
              </div>

              <div className="mt-4 rounded-lg border border-slate-200">
                <div className="border-b border-slate-200 bg-slate-50 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  Collect payment
                </div>
                <div className="grid grid-cols-2 gap-2 px-2 py-2">
                  <div>
                    <label className="erp-label" htmlFor="cash">
                      Cash
                    </label>
                    <input
                      id="cash"
                      type="number"
                      min="0"
                      value={form.cash}
                      onChange={(event) => setForm({ ...form, cash: event.target.value })}
                      className="erp-input"
                      placeholder="0"
                    />
                  </div>
                  <div>
                    <label className="erp-label" htmlFor="upi">
                      UPI
                    </label>
                    <input
                      id="upi"
                      type="number"
                      min="0"
                      value={form.upi}
                      onChange={(event) => setForm({ ...form, upi: event.target.value })}
                      className="erp-input"
                      placeholder="0"
                    />
                  </div>
                  {can(role, 'applyDiscount') && (
                    <div>
                      <label className="erp-label" htmlFor="discount">
                        Discount
                      </label>
                      <input
                        id="discount"
                        type="number"
                        min="0"
                        value={form.discount}
                        onChange={(event) => setForm({ ...form, discount: event.target.value })}
                        className="erp-input"
                        placeholder="0"
                      />
                    </div>
                  )}
                  {can(role, 'waiveFine') && (
                    <div className="flex items-end">
                      <label className="flex items-center gap-2 pb-1.5 text-[11px] text-slate-600">
                        <input
                          type="checkbox"
                          checked={form.waiveFine}
                          onChange={(event) => setForm({ ...form, waiveFine: event.target.checked })}
                          className="h-3.5 w-3.5 rounded border-slate-300"
                        />
                        Waive late fine
                      </label>
                    </div>
                  )}

                  {can(role, 'waiveFine') && active && active.lateFine > 0 && (
                    <div className="col-span-2">
                      <label className="erp-label" htmlFor="waiverReason">
                        Reason for fine waiver <span className="text-rose-500">*</span>
                      </label>
                      <input
                        id="waiverReason"
                        value={form.waiverReason}
                        onChange={(event) => setForm({ ...form, waiverReason: event.target.value })}
                        className="erp-input w-full"
                        placeholder="e.g. Principal approved / medical leave"
                      />
                    </div>
                  )}

                  <div className="col-span-2">
                    <label className="erp-label" htmlFor="note">
                      Note
                    </label>
                    <input
                      id="note"
                      value={form.note}
                      onChange={(event) => setForm({ ...form, note: event.target.value })}
                      className="erp-input"
                      placeholder="Counter remark"
                    />
                  </div>
                  <div className="col-span-2 flex items-center justify-between rounded-md bg-slate-50 px-2 py-1.5 text-[11px]">
                    <span className="text-slate-500">Balance after this receipt</span>
                    <span className="font-semibold text-slate-800">
                      {formatINR(round2(Number(active.paidAmount) + Number(form.cash || 0) + Number(form.upi || 0)))}
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-4">
                <div className="mb-1 flex items-center justify-between">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Payment history ({active.paymentHistory.length})
                  </p>
                  {active.paymentHistory.length > 3 && (
                    <span className="text-[10px] text-slate-400">Scroll for older</span>
                  )}
                </div>
                <ul className="max-h-44 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200">
                  {active.paymentHistory.map((entry) => (
                    <li key={entry.receiptNo} className="flex items-center justify-between px-2 py-1.5 text-[11px]">
                      <div>
                        <span className="font-mono text-[10px] text-slate-500">{entry.receiptNo}</span>
                        <span className="ml-1.5 text-slate-400">· {entry.date}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-slate-100 px-1 py-0.5 text-[9px] font-medium text-slate-600">
                          {entry.mode}
                        </span>
                        <span className="font-semibold text-slate-800">{formatINR(entry.amount)}</span>
                      </div>
                    </li>
                  ))}
                  {active.paymentHistory.length === 0 && (
                    <li className="px-2 py-3 text-center text-[11px] text-slate-400">No installments recorded yet.</li>
                  )}
                </ul>
              </div>

              <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[10px] leading-snug text-amber-800">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>
                  Receipts are posted to the daybook immediately. Scholarship revisions are approved by the accounts
                  office and reflected from the next billing cycle.
                </span>
              </div>
            </div>

            <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busyId === active.id || calculateStudentDues(active).pending <= 0}
                  onClick={() => submitDetailPayment(active)}
                  className="flex flex-1 items-center justify-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:bg-slate-300"
                >
                  <Receipt className="h-4 w-4" />
                  {calculateStudentDues(active).pending <= 0 ? 'No payment due' : 'Record payment'}
                </button>
                {can(role, 'waiveFine') && (
                  <button
                    type="button"
                    disabled={busyId === active.id || !form.waiverReason.trim() || active.lateFine <= 0}
                    onClick={() => waiveFine(active)}
                    title={active.lateFine <= 0 ? 'No late fine on this student' : !form.waiverReason.trim() ? 'Enter a reason to waive fine' : 'Waive late fine'}
                    className="rounded-md border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                  >
                    Waive fine
                  </button>
                )}
              </div>
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}
