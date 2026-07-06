// vendors.js — the household service directory: landscaper, HVAC, plumber.
// Row actions: call, and "Schedule" → appointment pre-linked to the vendor.

import { getAll, put, remove } from './store.js';
import { el, toast, openModal } from './ui.js';
import { editAppointmentModal } from './calendar.js';

export function vendorRow(vendor, { onchange } = {}) {
  return el('div', { class: 'vendor-row' }, [
    el('div', { class: 'vendor-main', onclick: () => editVendorModal(vendor, onchange) }, [
      el('span', { class: 'vendor-name' }, vendor.name),
      el('span', { class: 'vendor-service' }, [
        vendor.service || 'Service',
        vendor.lastUsedAt ? ` · last used ${vendor.lastUsedAt.slice(0, 10)}` : '',
      ].join('')),
    ]),
    el('div', { class: 'vendor-actions' }, [
      vendor.phone &&
        el('a', { class: 'vendor-btn', href: `tel:${vendor.phone.replace(/[^+\d]/g, '')}` }, 'Call'),
      el('button', {
        class: 'vendor-btn',
        onclick: async () => {
          await put('vendors', { ...vendor, lastUsedAt: new Date().toISOString() });
          editAppointmentModal(null, null, onchange, {
            title: `${vendor.service || 'Visit'}: ${vendor.name}`,
            vendorId: vendor.id,
          });
        },
      }, 'Schedule'),
    ]),
  ]);
}

// Create/edit bottom sheet.
export function editVendorModal(vendor, onchange) {
  const isNew = !vendor;
  const v = vendor || {};

  const name = el('input', { class: 'input', placeholder: 'e.g. GreenScape Landscaping', value: v.name || '' });
  const service = el('input', { class: 'input', placeholder: 'e.g. Landscaping', value: v.service || '' });
  const phone = el('input', { class: 'input', type: 'tel', placeholder: 'Phone', value: v.phone || '' });
  const email = el('input', { class: 'input', type: 'email', placeholder: 'Email', value: v.email || '' });
  const notes = el('textarea', { class: 'input', rows: 2, placeholder: 'Notes (rates, gate code, who referred them…)' }, v.notes || '');

  const actions = [
    !isNew &&
      el('button', {
        class: 'btn btn-danger',
        onclick: async () => {
          await remove('vendors', v.id);
          toast('Vendor deleted');
          m.close();
          onchange?.();
        },
      }, 'Delete'),
    el('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
    el('button', {
      class: 'btn btn-primary',
      onclick: async () => {
        if (!name.value.trim()) return toast('Give the vendor a name', 'warn');
        await put('vendors', {
          ...v,
          name: name.value.trim(),
          service: service.value.trim() || null,
          phone: phone.value.trim() || null,
          email: email.value.trim() || null,
          notes: notes.value.trim() || null,
        });
        m.close();
        onchange?.();
      },
    }, isNew ? 'Add vendor' : 'Save'),
  ];

  const m = openModal(isNew ? 'New vendor' : 'Edit vendor', [
    el('label', { class: 'field-label' }, 'Name'),
    name,
    el('label', { class: 'field-label' }, 'Service'),
    service,
    el('div', { class: 'field-row' }, [
      el('div', {}, [el('label', { class: 'field-label' }, 'Phone'), phone]),
      el('div', {}, [el('label', { class: 'field-label' }, 'Email'), email]),
    ]),
    notes,
  ], actions);
  name.focus();
}

// Section used inside the Upkeep view (not a standalone route).
export async function vendorsSection(onchange) {
  const vendors = await getAll('vendors');
  return [
    el('div', { class: 'panel-head' }, [
      el('h4', {}, 'Vendors'),
      el('button', { class: 'link', onclick: () => editVendorModal(null, onchange) }, '+ Vendor'),
    ]),
    el('section', { class: 'panel' },
      vendors.length
        ? vendors
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((v) => vendorRow(v, { onchange }))
        : [el('p', { class: 'muted small' }, 'No vendors yet. Add the landscaper, HVAC tech, plumber…')]
    ),
  ];
}
